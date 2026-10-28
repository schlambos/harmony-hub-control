package app.melodious.system

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The hub's SSH private key (the installer's harmony_owner_… key), used to update the hub. Encrypted
 * with an AES-GCM key held in the Android Keystore, like the Logitech tokens: if the Keystore fails,
 * nothing is stored, and an undecryptable blob is deleted on read.
 */
class HubKeyStore(context: Context) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)

    fun load(): String? {
        val blob = prefs.getString(KEY_BLOB, null)?.takeIf { it.isNotBlank() } ?: return null
        return try {
            val (iv, cipherText) = blob.split(':', limit = 2).map { Base64.decode(it, Base64.NO_WRAP) }
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(GCM_TAG_BITS, iv))
            String(cipher.doFinal(cipherText), Charsets.UTF_8)
        } catch (_: Exception) {
            clear()
            null
        }
    }

    /** False when the Keystore couldn't encrypt it; nothing is stored then. */
    fun save(privateKeyPem: String): Boolean = try {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val blob = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" +
            Base64.encodeToString(cipher.doFinal(privateKeyPem.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
        prefs.edit().putString(KEY_BLOB, blob).commit()
    } catch (_: Exception) {
        clear()
        false
    }

    fun clear() {
        runCatching { prefs.edit().remove(KEY_BLOB).commit() }
    }

    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
    }

    private companion object {
        const val PREFS_FILE = "melodious_hub_key"
        const val KEY_BLOB = "ssh_private_key"
        const val KEY_ALIAS = "melodious_hub_ssh_key"
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val GCM_TAG_BITS = 128
    }
}
