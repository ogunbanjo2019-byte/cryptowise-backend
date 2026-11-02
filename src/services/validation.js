export function validAtomic(value) { return typeof value==='string' && /^[1-9][0-9]{0,77}$/.test(value); }
export function validTxHash(value) { return typeof value==='string' && /^0x[a-fA-F0-9]{64}$/.test(value); }
export function validEvmAddress(value) { return typeof value==='string' && /^0x[a-fA-F0-9]{40}$/.test(value); }
export function parseDecimalToAtomic(value, decimals) {
  if(typeof value!=='string'||!Number.isInteger(decimals)||decimals<0||decimals>36||!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)) throw new Error('Invalid decimal amount.');
  const [whole,fraction='']=value.split('.');
  if(fraction.length>decimals) throw new Error('Amount has too many decimal places.');
  const atomic=(BigInt(whole)*10n**BigInt(decimals)+BigInt((fraction+'0'.repeat(decimals)).slice(0,decimals)||'0')).toString();
  if(atomic==='0') throw new Error('Amount must be greater than zero.');
  return atomic;
}
