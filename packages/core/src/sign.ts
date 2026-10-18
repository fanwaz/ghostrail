import { Account, Keypair, Memo, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { parseAsset } from "./asset.js";
import { toHex } from "./bytes.js";
import { systemClock, type Clock } from "./clock.js";
import { GhostRailError } from "./errors.js";
import { NETWORK_PASSPHRASE, OFFLINE_FEE_STROOPS } from "./network.js";
import { validateRequest, type PaymentRequest } from "./request.js";

/**
 * The customer's account as last seen online. Stellar: a tx must carry the
 * account's next sequence number, so an offline wallet signs against a cached
 * value and advances it locally after every signature.
 */
export interface OfflineAccount {
  publicKey: string;
  /** Current (last used) sequence number, as Horizon reports it. */
  sequence: string;
}

export interface SignedPayment {
  /** Base64 TransactionEnvelope XDR — what the customer hands to the merchant. */
  xdr: string;
  /** Hex tx hash: the idempotency key for the whole pipeline. */
  hash: string;
  /** The wallet must persist this as the new cached sequence. */
  nextSequence: string;
}

/**
 * Builds and signs a payment for `request` without any network access.
 *
 * Prefer {@link PayerWallet.pay}, which caches and advances the sequence for you.
 *
 * TODO(multisig): accounts with thresholds > 1 need additional signers here.
 * TODO(sequence-gaps): PayerWallet serializes signing on one device, but the same
 * account used on two devices still conflicts; channel accounts would fix that.
 */
export function buildOfflinePayment(params: {
  request: PaymentRequest;
  signer: Keypair;
  account: OfflineAccount;
  clock?: Clock;
}): SignedPayment {
  const request = validateRequest(params.request);
  const now = (params.clock ?? systemClock)();
  if (request.expiresAt <= now) {
    throw new GhostRailError("EXPIRED", "Payment request has already expired");
  }
  if (params.signer.publicKey() !== params.account.publicKey) {
    throw new GhostRailError("BAD_SIGNATURE", "Signer does not match the paying account");
  }

  const source = new Account(params.account.publicKey, params.account.sequence);
  const tx = new TransactionBuilder(source, {
    fee: String(OFFLINE_FEE_STROOPS),
    networkPassphrase: NETWORK_PASSPHRASE,
    // Stellar: maxTime makes validators reject the tx after expiry, even if a relayer replays it.
    timebounds: { minTime: 0, maxTime: request.expiresAt },
    memo: Memo.text(request.id),
  })
    .addOperation(
      Operation.payment({
        destination: request.destination,
        asset: parseAsset(request.asset),
        amount: request.amount,
      }),
    )
    .build();

  tx.sign(params.signer);
  return {
    xdr: tx.toEnvelope().toXDR("base64"),
    hash: toHex(tx.hash()),
    nextSequence: source.sequenceNumber(),
  };
}
