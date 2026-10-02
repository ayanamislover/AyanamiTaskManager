package moe.ayanami.atm;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.regex.Pattern;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * 配对信息的加密存储：AndroidKeyStore 里一把不可导出的 AES-256-GCM 密钥，
 * 密文（IV + 密文 + 标签）以 base64 存进应用私有的 SharedPreferences。
 *
 * <p>AAD 是条目名：把 A 条目的密文挪到 B 条目下会解密失败，而不是悄悄读出别的东西。
 * 解不开（Keystore 被清、换机恢复、数据损坏）一律当作「没有」返回 null 并删掉坏条目——
 * 网页会回到配对页，而不是卡在一个永远读不出来的状态。
 *
 * <p>不用 androidx.security-crypto：它不在本机的离线依赖缓存里，而且这里只存两三条字符串，
 * 直接用 Keystore 更少一层。
 */
final class SecureStore {
    private static final String PREFS = "atm_secure";
    private static final String KEY_ALIAS = "moe.ayanami.atm.secure.v1";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final int IV_BYTES = 12;
    private static final int TAG_BITS = 128;
    private static final Pattern NAME = Pattern.compile("^[a-z0-9._-]{1,64}$");

    private final SharedPreferences prefs;

    SecureStore(Context context) {
        this.prefs = context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static boolean validName(String name) {
        return name != null && NAME.matcher(name).matches();
    }

    synchronized String get(String name) {
        String stored = prefs.getString(name, null);
        if (stored == null) return null;
        try {
            byte[] packed = Base64.decode(stored, Base64.NO_WRAP);
            if (packed.length <= IV_BYTES) throw new GeneralSecurityException("too short");
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(TAG_BITS, packed, 0, IV_BYTES));
            cipher.updateAAD(name.getBytes(StandardCharsets.UTF_8));
            byte[] plain = cipher.doFinal(packed, IV_BYTES, packed.length - IV_BYTES);
            return new String(plain, StandardCharsets.UTF_8);
        } catch (GeneralSecurityException | IllegalArgumentException | java.io.IOException unusable) {
            // 不记录原因：异常消息里可能带出密文片段。
            prefs.edit().remove(name).commit();
            return null;
        }
    }

    synchronized void set(String name, String value) throws GeneralSecurityException, java.io.IOException {
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(Cipher.ENCRYPT_MODE, key(true));
        cipher.updateAAD(name.getBytes(StandardCharsets.UTF_8));
        byte[] iv = cipher.getIV();
        byte[] sealed = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        byte[] packed = new byte[iv.length + sealed.length];
        System.arraycopy(iv, 0, packed, 0, iv.length);
        System.arraycopy(sealed, 0, packed, iv.length, sealed.length);
        // commit 而不是 apply：网页拿到 resolve 之后进程被杀，配对也不能丢。
        if (!prefs.edit().putString(name, Base64.encodeToString(packed, Base64.NO_WRAP)).commit()) {
            throw new java.io.IOException("无法写入安全存储");
        }
    }

    synchronized void remove(String name) {
        prefs.edit().remove(name).commit();
    }

    private static SecretKey key(boolean create) throws GeneralSecurityException, java.io.IOException {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        KeyStore.Entry entry = keyStore.getEntry(KEY_ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        if (!create) throw new GeneralSecurityException("no key");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(
            new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build()
        );
        return generator.generateKey();
    }
}
