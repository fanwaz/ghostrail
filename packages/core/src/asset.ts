import { Asset, StrKey } from "@stellar/stellar-sdk";
import { GhostRailError } from "./errors.js";

/**
 * Serialized asset reference: "native" for XLM, or "CODE:ISSUER" for an issued asset
 * (e.g. testnet USDC). Kept as a string so it is QR- and SQL-friendly.
 */
export type AssetRef = string;

export function parseAsset(ref: AssetRef): Asset {
  if (ref === "native") return Asset.native();
  const [code, issuer, ...rest] = ref.split(":");
  if (!code || !issuer || rest.length > 0 || !/^[A-Za-z0-9]{1,12}$/.test(code) || !StrKey.isValidEd25519PublicKey(issuer)) {
    throw new GhostRailError("INVALID_REQUEST", `Invalid asset "${ref}"`);
  }
  return new Asset(code, issuer);
}

export function assetToRef(asset: Asset): AssetRef {
  return asset.isNative() ? "native" : `${asset.getCode()}:${asset.getIssuer()}`;
}
