package io.titan.pos.hal.tokenizer

/**
 * Opaque, single-use payment instrument returned by a PCI-certified capture
 * component (the PSP card form, or a SPoC/CPoC/MPoC-certified reader SDK).
 *
 * Titan code NEVER holds the PAN or CVV — only this token, which is single-use
 * and short-lived. This is the artifact that keeps the POS out of PCI SAQ-D
 * scope: there is no field here (and no method on [ICardTokenizer]) that carries
 * a primary account number or a card verification value.
 */
data class PaymentToken(
    /** PSP single-use charge token (e.g. a Viva Wallet chargeToken). */
    val token: String,
    /** Display/print/store-safe masked PAN, e.g. "411111****1111". Never the full PAN. */
    val maskedPan: String,
    val cardBrand: CardBrand,
    /** Expiry is non-sensitive display data (for the receipt/AVS), not the PAN. */
    val expiryMonth: Int,
    val expiryYear: Int,
    /** Which certified component produced the token ("viva", "pax-spoc", …). */
    val tokenProvider: String,
    /** Token TTL — the backend rejects a charge attempt after this instant. */
    val expiresAtEpochMs: Long,
)

enum class CardBrand { VISA, MASTERCARD, AMEX, DISCOVER, DINERS, JCB, UNIONPAY, UNKNOWN }
