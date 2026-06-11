package com.natstack.mobile

import android.content.Context
import java.io.File
import java.security.MessageDigest

object NatStackBundleStore {
    private const val PREFS = "natstack-mobile-host"
    private const val ACTIVE_LOCAL_PATH = "activeBundle.localPath"
    private const val ACTIVE_BUILD_KEY = "activeBundle.buildKey"
    private const val ACTIVE_INTEGRITY = "activeBundle.integrity"

    fun activeBundlePath(context: Context): String? {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val localPath = prefs.getString(ACTIVE_LOCAL_PATH, null) ?: return null
        val integrity = prefs.getString(ACTIVE_INTEGRITY, null) ?: return null
        val file = File(localPath)
        if (isUnderBundleCache(context, file) && file.isFile && hasSha256Integrity(integrity, readBytesOrNull(file))) {
            return file.absolutePath
        }
        prefs.edit()
            .remove(ACTIVE_LOCAL_PATH)
            .remove(ACTIVE_BUILD_KEY)
            .remove(ACTIVE_INTEGRITY)
            .apply()
        return null
    }

    fun activate(context: Context, localPath: String, buildKey: String, integrity: String): Boolean {
        val file = File(localPath)
        if (!isUnderBundleCache(context, file) || !file.isFile) {
            throw IllegalArgumentException("Prepared React Native bundle is outside the app cache")
        }
        if (!hasSha256Integrity(integrity, readBytesOrNull(file))) {
            throw IllegalArgumentException("Prepared React Native bundle integrity mismatch")
        }
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val currentPath = prefs.getString(ACTIVE_LOCAL_PATH, null)
        val currentBuildKey = prefs.getString(ACTIVE_BUILD_KEY, null)
        val currentIntegrity = prefs.getString(ACTIVE_INTEGRITY, null)
        val changed = currentPath != file.absolutePath || currentBuildKey != buildKey || currentIntegrity != integrity
        prefs.edit()
            .putString(ACTIVE_LOCAL_PATH, file.absolutePath)
            .putString(ACTIVE_BUILD_KEY, buildKey)
            .putString(ACTIVE_INTEGRITY, integrity)
            .commit()
        return changed
    }

    private fun isUnderBundleCache(context: Context, file: File): Boolean {
        val root = File(context.cacheDir, "natstack-rn").canonicalFile
        val candidate = file.canonicalFile
        return candidate.path == root.path || candidate.path.startsWith("${root.path}${File.separator}")
    }

    private fun readBytesOrNull(file: File): ByteArray? = try {
        file.readBytes()
    } catch (_: Exception) {
        null
    }

    private fun hasSha256Integrity(integrity: String, bytes: ByteArray?): Boolean {
        if (bytes == null) return false
        val expected = integrity.removePrefix("sha256-")
        if (expected.length != 64 || expected.any { it !in '0'..'9' && it !in 'a'..'f' && it !in 'A'..'F' }) {
            return false
        }
        val actual = MessageDigest.getInstance("SHA-256")
            .digest(bytes)
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }
        return actual.equals(expected, ignoreCase = true)
    }
}
