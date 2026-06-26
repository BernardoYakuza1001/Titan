package io.titan.pos.hal.tokenizer.vendor.pax

import io.titan.pos.hal.tokenizer.PaymentToken

/**
 * Exchanges a PAX P2PE-encrypted card payload for a single-use Viva chargeToken.
 *
 * Recommended implementation: POST the ciphertext + KSN to the TITAN BACKEND,
 * which holds the Viva credentials and calls Viva's tokenization — so the gateway
 * keys never live on the terminal and the device stays SAQ-A. Returns ONLY a
 * token + masked metadata; never card data.
 */
interface VivaTokenization {
    suspend fun tokenize(card: PaxEncryptedCard, correlationToken: String): PaymentToken
}
