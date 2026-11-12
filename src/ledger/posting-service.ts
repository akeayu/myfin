import { createPostedEntry, validateJournalEntry, type JournalEntryInput, type PostedJournalEntry } from "./ledger.js";

export interface LedgerTransaction {
  findPostedByIdempotencyKey(entityId:string,key:string):Promise<PostedJournalEntry|null>;
  assertAccountsBelongToEntity(entityId:string,accountIds:readonly string[],currencies:readonly string[]):Promise<void>;
  /** Must rely on database uniqueness constraints and commit atomically. */
  insertPostedEntry(entry:PostedJournalEntry):Promise<void>;
}
export interface LedgerRepository {
  /** Implement as a serializable transaction or equivalent atomic unit. */
  transaction<T>(work:(tx:LedgerTransaction)=>Promise<T>):Promise<T>;
}
export interface PostingResult { readonly status:"posted"|"duplicate"; readonly entry:PostedJournalEntry }

export async function sha256Hex(value:string):Promise<string> {
  if(!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable.");
  const digest=await globalThis.crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("");
}

function canonicalJournal(e:JournalEntryInput):string {
  const lines=[...e.lines].map(l=>({
    accountId:l.accountId,currency:l.currency,debitMinor:l.debitMinor.toString(),
    creditMinor:l.creditMinor.toString(),memo:l.memo??null,
  })).sort((a,b)=>a.accountId.localeCompare(b.accountId)||a.currency.localeCompare(b.currency)
    ||a.debitMinor.localeCompare(b.debitMinor)||a.creditMinor.localeCompare(b.creditMinor));
  return JSON.stringify({
    id:e.id,entityId:e.entityId,idempotencyKey:e.idempotencyKey,effectiveDate:e.effectiveDate,
    recordedAt:e.recordedAt,calendarSystem:e.calendarSystem,
    calendarAlgorithmVersion:e.calendarAlgorithmVersion,sourceReference:e.sourceReference,lines,
  });
}

export async function postJournalEntry(
  input:JournalEntryInput,
  repository:LedgerRepository,
  now:()=>string=()=>new Date().toISOString(),
):Promise<PostingResult> {
  validateJournalEntry(input);
  const hash=await sha256Hex(canonicalJournal(input));
  return repository.transaction(async tx=>{
    const existing=await tx.findPostedByIdempotencyKey(input.entityId,input.idempotencyKey);
    if(existing){
      if(existing.contentHash!==hash) throw new Error("Idempotency key was already used for a different journal payload.");
      return {status:"duplicate",entry:existing};
    }
    await tx.assertAccountsBelongToEntity(input.entityId,
      [...new Set(input.lines.map(l=>l.accountId))],
      [...new Set(input.lines.map(l=>l.currency))]);
    const entry=createPostedEntry(input,now(),hash);
    await tx.insertPostedEntry(entry);
    return {status:"posted",entry};
  });
}
