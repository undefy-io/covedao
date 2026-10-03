(() => {
  const account = window.__crcChainAccount;
  window.__COVE_TEST_WALLET__ = {
    id: "owned-chain-wallet",
    connect: async () => ({ adapterId: "owned-chain-wallet", paymentAddress: account.address,
      paymentScript: account.script, paymentPublicKey: account.publicKey, ordinalsAddress: account.ordinalsAddress,
      ordinalsScript: account.ordinalsScript, ordinalsPublicKey: account.publicKey, network: "regtest",
      capabilities: { psbt: true, bip322Simple: true, p2wpkh: true, p2shP2wpkh: true, p2tr: true, utxoDiscovery: true } }),
    signPsbt: ({ psbtBase64, operation }) => window.__crcChainSign(psbtBase64, operation),
    signBip322Simple: ({ message }) => window.__crcChainMessage(message),
    getUtxos: async () => {
      const result = await (await fetch("/api/crc/v1/wallet/utxos?address=" + encodeURIComponent(account.address))).json();
      if (!result.ok) throw new Error(JSON.stringify(result)); return result.data.utxos;
    },
  };
})();
