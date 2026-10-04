import { expect, test } from "vitest";
import * as core from "@crclaunch/crc20-protocol";
import { parseCrcMarketQuantity, selectCrcListingCoins } from "./crc-market-amount";
const coin = (tokens: bigint, id: string) => ({txid:id.repeat(64),vout:0,atoms:(tokens*core.atomsPerToken).toString(),btcSats:"1000",scriptHex:"0014"+"aa".repeat(20)});
test("market amounts are exact through eight decimals without curve steps",()=>{
 expect(parseCrcMarketQuantity("300")).toBe(300n*core.atomsPerToken);
 expect(parseCrcMarketQuantity("1.23456789")).toBe(123456789n);
 expect(parseCrcMarketQuantity("0.00000001")).toBe(1n);
 for(const value of ["0","-1","1e3","1.000000001","21000001","NaN","1,000","01","1."]) expect(()=>parseCrcMarketQuantity(value)).toThrow();
});
test("prefers exact available coin, excludes listed anchors, and selects amount with change",()=>{
 const coins=[coin(400n,"a"),coin(300n,"b"),coin(100n,"c")];
 expect(selectCrcListingCoins(coins,300n*core.atomsPerToken,[],false)).toEqual([coins[1]]);
 expect(selectCrcListingCoins(coins,300n*core.atomsPerToken,[{txid:coins[1]!.txid,vout:0}],false)).toEqual([coins[0]]);
 expect(selectCrcListingCoins(coins,500n*core.atomsPerToken,[],false)).toEqual([coins[0],coins[1]]);
 expect(()=>selectCrcListingCoins(coins,900n*core.atomsPerToken,[],false)).toThrow(/available/);
 expect(()=>selectCrcListingCoins(coins,100n*core.atomsPerToken,[],true)).toThrow(/incomplete/);
});
test("rejects selection beyond32 inputs and duplicate indexed data",()=>{
 const coins=Array.from({length:33},(_,i)=>({...coin(1n,"a"),txid:i.toString(16).padStart(64,"0")}));
 expect(()=>selectCrcListingCoins(coins,33n*core.atomsPerToken,[],false)).toThrow(/32/);
 expect(()=>selectCrcListingCoins([coins[0]!,coins[0]!],core.atomsPerToken,[],false)).toThrow(/Duplicate/);
});
