import * as core from "@crclaunch/crc20-protocol";
export type CrcListingCoin = {txid:string;vout:number;atoms:string;btcSats:string;scriptHex:string};
export function parseCrcMarketQuantity(value:string):bigint {
  if (!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,8})?$/.test(value)) throw new Error("Enter a positive token amount with up to 8 decimal places");
  const [whole,fraction=""] = value.split(".");
  const atoms = BigInt(whole!) * core.atomsPerToken + BigInt(fraction.padEnd(8,"0"));
  if(atoms<=0n || atoms>core.capAtoms) throw new Error("Amount must be positive and within the token supply");
  return atoms;
}
export function selectCrcListingCoins(coins:CrcListingCoin[],amount:bigint,unavailable:{txid:string;vout:number}[],truncated:boolean):CrcListingCoin[] {
  if(truncated) throw new Error("Token or listing balance is incomplete. Reduce the number of outputs or listings first.");
  if(amount<=0n || amount>core.capAtoms) throw new Error("Invalid listing amount");
  const seen=new Set<string>();
  for(const coin of coins) {
    if(seen.has(core.outpoint(coin))) throw new Error("Duplicate indexed token output");
    seen.add(core.outpoint(coin));
    if(!/^[1-9]\d*$/.test(coin.atoms)) throw new Error("Invalid indexed token amount");
  }
  const blocked=new Set(unavailable.map(core.outpoint));
  const available=coins.filter(coin=>!blocked.has(core.outpoint(coin))).sort((a,b)=>{
    const aa=BigInt(a.atoms),bb=BigInt(b.atoms);
    return aa>bb?-1:aa<bb?1:core.outpoint(a).localeCompare(core.outpoint(b));
  });
  const exact=available.find(coin=>BigInt(coin.atoms)===amount);
  if(exact) return [exact];
  const selected:CrcListingCoin[]=[];let total=0n;
  for(const coin of available) {if(total>=amount) break;selected.push(coin);total+=BigInt(coin.atoms);}
  if(total<amount) throw new Error("Not enough available tokens for this listing");
  if(selected.length>32) throw new Error("This amount needs more than 32 token outputs. Choose a smaller amount or consolidate first.");
  return selected;
}
