import * as bitcoin from "bitcoinjs-lib";
import {beforeEach,expect,test,vi} from "vitest";
const mocks=vi.hoisted(()=>({scan:vi.fn(),save:vi.fn(),network:"signet"}));
vi.mock("@crclaunch/db",async original=>({...await original<Record<string,unknown>>(),saveWalletFundingSnapshot:mocks.save}));
vi.mock("@/lib/crc-mutation",()=>({getCrcMutationServices:()=>({db:{},provider:{},config:{network:mocks.network}})}));
vi.mock("@/lib/regtest-scan",()=>({regtestScans:{scan:mocks.scan}}));
vi.mock("@/lib/crc-rate-limit",()=>({checkCrcRateLimit:()=>undefined}));
import {GET} from "./route";
beforeEach(()=>{mocks.network="signet";mocks.scan.mockReset();mocks.save.mockReset().mockResolvedValue(undefined);});
test.each(["signet","testnet","mainnet"])("%s has no backend wallet discovery fallback",async network=>{
 mocks.network=network;
 const response=await GET(new Request("http://localhost/api/crc/v1/wallet/utxos?address=tb1qg358gsla30dtx228u3za8253zncpzdwkrl6eem"));
 expect(response.status).toBe(410);expect((await response.json()).error.code).toBe("BROWSER_DISCOVERY_REQUIRED");
 expect(mocks.scan).not.toHaveBeenCalled();expect(mocks.save).not.toHaveBeenCalled();
});
test("regtest retains its explicit Core developer-wallet discovery",async()=>{
 mocks.network="regtest";mocks.scan.mockResolvedValue([{txid:"ab".repeat(32),vout:0,amount:0.0001}]);
 const address=bitcoin.payments.p2wpkh({hash:Buffer.alloc(20,1),network:bitcoin.networks.regtest}).address!;
 const response=await GET(new Request("http://localhost/api/crc/v1/wallet/utxos?address="+address));
 expect(response.status).toBe(200);expect((await response.json()).data).toMatchObject({source:"core",utxos:[{valueSats:"10000"}]});
 expect(mocks.scan).toHaveBeenCalledOnce();expect(mocks.save).toHaveBeenCalledOnce();
});
