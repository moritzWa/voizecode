import { digest, SyncError } from '../sync/projection.mjs';
const scope=p=>[p.owner_id,p.device_id,p.database_epoch];
const where='owner_id=$1 AND device_id=$2 AND database_epoch=$3';

export class Outbox {
  constructor(db,gate) { this.db=db;this.gate=gate; }
  async send(principal,{operation_id,session_id,text,base_cursor}) {
    if(!principal.scopes?.split(' ').includes('messages:send'))throw new SyncError('write_permission_required',403);
    if(!/^[A-Za-z0-9_-]{8,160}$/.test(operation_id??'') || typeof session_id!=='string' || session_id.length>200 || typeof text!=='string' || !text.trim() || text.length>50_000 || !Number.isSafeInteger(base_cursor) || base_cursor<0)throw new SyncError('invalid_message',400);
    const hash=await digest({operation_id,session_id,text,base_cursor});
    // Signal first: a failed DB write causes a harmless extra poll, not a stranded message.
    await this.gate.signal(`${principal.device_id}|${principal.database_epoch}`);
    const receipt=await this.db.transaction(async tx=>{
      const s=scope(principal);
      const device=(await tx.query(`SELECT 1 FROM av_credentials WHERE ${where} AND audience='sync' AND revoked=false AND expires_at>$4 LIMIT 1`,[...s,Date.now()])).rows[0];
      if(!device)throw new SyncError('device_disconnected',409);
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',[JSON.stringify([...s,operation_id])]);
      const old=(await tx.query(`SELECT * FROM av_outbox WHERE ${where} AND operation_id=$4`,[...s,operation_id])).rows[0];
      if(old) { if(old.payload_hash!==hash)throw new SyncError('operation_id_conflict');return publicReceipt(old); }
      const session=(await tx.query(`SELECT cursor,state FROM av_sessions WHERE ${where} AND session_id=$4 AND cursor IS NOT NULL`,[...s,session_id])).rows[0];
      if(!session || session.state.deleted)throw new SyncError('session_not_found',404);
      if(Number(session.cursor)!==base_cursor)throw new SyncError('context_changed_re_read_and_confirm',409);
      const row=(await tx.query(`INSERT INTO av_outbox (owner_id,device_id,database_epoch,operation_id,session_id,message_id,text,payload_hash,base_cursor,created_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[...s,operation_id,session_id,`msg_agentvoice_${operation_id}`,text,hash,base_cursor,Date.now(),Date.now()+86400_000])).rows[0];
      return publicReceipt(row);
    });
    // The first signal can be consumed before Postgres commits. Signal again
    // after commit; periodic connector reconciliation covers a process crash
    // between these two durable services.
    await this.gate.signal(`${principal.device_id}|${principal.database_epoch}`);
    return receipt;
  }
  async lease(principal) {
    return this.db.transaction(async tx=>{
      const s=scope(principal),now=Date.now();
      await tx.query(`UPDATE av_outbox SET state=CASE WHEN state='queued' THEN 'expired' ELSE 'uncertain' END WHERE ${where} AND state IN ('queued','leased') AND expires_at<=$4`,[...s,now]);
      const row=(await tx.query(`SELECT * FROM av_outbox q WHERE ${where} AND (state='queued' OR (state='leased' AND lease_until<$4))
        AND NOT EXISTS (SELECT 1 FROM av_outbox earlier WHERE earlier.owner_id=q.owner_id AND earlier.device_id=q.device_id AND earlier.database_epoch=q.database_epoch
        AND earlier.session_id=q.session_id AND earlier.sequence<q.sequence AND earlier.state IN ('queued','leased','needs_confirmation','uncertain'))
        ORDER BY sequence LIMIT 1 FOR UPDATE SKIP LOCKED`,[...s,now])).rows[0];
      if(!row)return null;
      const live=(await tx.query(`SELECT cursor,state FROM av_sessions WHERE ${where} AND session_id=$4`,[...s,row.session_id])).rows[0];
      if(!live || live.state.deleted || Number(live.cursor)!==Number(row.base_cursor)) {
        await tx.query(`UPDATE av_outbox SET state='needs_confirmation' WHERE ${where} AND operation_id=$4`,[...s,row.operation_id]);
        return {needs_confirmation:row.operation_id};
      }
      await tx.query(`UPDATE av_outbox SET state='leased',lease_until=$5 WHERE ${where} AND operation_id=$4`,[...s,row.operation_id,now+60_000]);
      return {operation_id:row.operation_id,session_id:row.session_id,message_id:row.message_id,text:row.text,base_cursor:Number(row.base_cursor),expires_at:Number(row.expires_at)};
    });
  }
  async ack(principal,{operation_id,message_id,status}) {
    if(!['accepted','needs_confirmation','failed'].includes(status))throw new SyncError('invalid_receipt',400);
    const result=await this.db.query(`UPDATE av_outbox SET state=$6,receipt=$7 WHERE ${where} AND operation_id=$4 AND message_id=$5 AND state IN ('leased','needs_confirmation','uncertain','expired',$6) RETURNING *`,
      [...scope(principal),operation_id,message_id,status,JSON.stringify({message_id,status})]);
    if(!result.rows.length)throw new SyncError('receipt_conflict');
    return publicReceipt(result.rows[0]);
  }
  async status(principal,operation_id) {
    await this.db.query(`UPDATE av_outbox SET state=CASE WHEN state='queued' THEN 'expired' ELSE 'uncertain' END WHERE ${where} AND operation_id=$4 AND state IN ('queued','leased') AND expires_at<=$5`,[...scope(principal),operation_id,Date.now()]);
    const row=(await this.db.query(`SELECT * FROM av_outbox WHERE ${where} AND operation_id=$4`,[...scope(principal),operation_id])).rows[0];
    if(!row)throw new SyncError('message_not_found',404);return publicReceipt(row);
  }
  async cancel(principal,operation_id) {
    if(!principal.scopes?.split(' ').includes('messages:send'))throw new SyncError('write_permission_required',403);
    const row=(await this.db.query(`UPDATE av_outbox SET state='cancelled' WHERE ${where} AND operation_id=$4 AND state IN ('queued','needs_confirmation','cancelled') RETURNING *`,[...scope(principal),operation_id])).rows[0];
    if(!row)throw new SyncError('cannot_cancel_admitted_or_inflight_message',409);
    await this.gate.signal(`${principal.device_id}|${principal.database_epoch}`);
    return publicReceipt(row);
  }
}
function publicReceipt(row) { return {operation_id:row.operation_id,session_id:row.session_id,status:row.state,message_id:row.message_id,expires_at:Number(row.expires_at)}; }
