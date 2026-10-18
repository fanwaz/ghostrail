import { Networks } from "@stellar/stellar-sdk";

/**
 * GhostRail is testnet-only. Every module that touches the network imports
 * these constants instead of accepting arbitrary passphrases/URLs, so mainnet
 * cannot be reached by misconfiguration.
 */

/** Stellar: the passphrase is hashed into every tx hash, so a testnet signature is invalid on mainnet. */
export const NETWORK_PASSPHRASE = Networks.TESTNET;

export const HORIZON_URL = "https://horizon-testnet.stellar.org";

export const FRIENDBOT_URL = "https://friendbot.stellar.org";

/**
 * Stellar: offline signers cannot query fee stats, so we pay a fixed fee
 * (stroops per operation) well above the 100-stroop base to survive surge pricing.
 */
export const OFFLINE_FEE_STROOPS = 1_000;
