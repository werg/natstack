package com.natstack.mobile

import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import org.json.JSONObject
import java.io.BufferedReader
import java.io.File
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlin.concurrent.thread

class NatStackMobileHostModule(
    reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
    private val prefs: SharedPreferences =
        reactContext.getSharedPreferences("natstack-mobile-host", Context.MODE_PRIVATE)

    override fun getName(): String = "NatStackMobileHost"

    override fun getConstants(): MutableMap<String, Any> = hashMapOf(
        "firebaseConfigured" to BuildConfig.NATSTACK_HAS_FIREBASE
    )

    @ReactMethod
    fun getCredentials(promise: Promise) {
        try {
            val credential = loadCredential()
            promise.resolve(credential?.toPublicMap())
        } catch (error: Exception) {
            promise.reject("needs_repair", "Stored mobile credentials could not be decrypted", error)
        }
    }

    @ReactMethod
    fun clearCredentials(promise: Promise) {
        clearStoredCredentials()
        promise.resolve(null)
    }

    @ReactMethod
    fun resetToNativeBootstrap(promise: Promise) {
        try {
            clearStoredCredentials()
            NatStackBundleStore.clearActive(reactApplicationContext)
            promise.resolve(Arguments.createMap().apply {
                putBoolean("reloading", true)
            })
            Handler(Looper.getMainLooper()).post {
                try {
                    Log.i(TAG, "[NatStackMobileSmoke] phase=native-bootstrap-reset")
                    reloadReactNative()
                } catch (error: Exception) {
                    Log.e(TAG, "Failed to reload React Native after bootstrap reset", error)
                }
            }
        } catch (error: Exception) {
            promise.reject("bootstrap_reset_failed", error.message, error)
        }
    }

    @ReactMethod
    fun pairServer(serverUrl: String, code: String, promise: Promise) {
        thread(start = true, isDaemon = true, name = "NatStackPairing") {
            try {
                val normalizedUrl = normalizeServerUrl(serverUrl)
                val response = postJson(
                    normalizedUrl,
                    "/_r/s/auth/complete-pairing",
                    JSONObject()
                        .put("code", code)
                        .put("label", "Mobile device")
                        .put("platform", "mobile")
                )
                val credential = Credential(
                    serverUrl = normalizedUrl,
                    hubUrl = normalizedUrl,
                    deviceId = response.getString("deviceId"),
                    refreshToken = response.getString("refreshToken"),
                    serverId = response.getString("serverId").takeIf { it.isNotBlank() }
                        ?: throw IllegalStateException("Pairing response did not include a server id"),
                    workspaceId = "",
                    workspaceName = null,
                )
                saveCredential(credential)
                Log.i(TAG, "[NatStackMobileSmoke] phase=native-pairing-complete")
                promise.resolve(Arguments.createMap().apply {
                    putString("serverUrl", credential.serverUrl)
                    putString("hubUrl", credential.hubUrl)
                    putString("deviceId", credential.deviceId)
                    putString("serverId", credential.serverId)
                })
            } catch (error: Exception) {
                promise.reject("pairing_failed", error.message, error)
            }
        }
    }

    @ReactMethod
    fun listWorkspaces(promise: Promise) {
        thread(start = true, isDaemon = true, name = "NatStackWorkspaceList") {
            try {
                val credential = loadCredential()
                    ?: throw IllegalStateException("No mobile credentials are stored")
                val hubUrl = credential.hubUrl
                    ?: throw IllegalStateException("Stored credential is missing a hub URL")
                val response = postJson(
                    hubUrl,
                    "/_r/s/workspaces/list",
                    JSONObject()
                        .put("deviceId", credential.deviceId)
                        .put("refreshToken", credential.refreshToken)
                )
                val workspaces = Arguments.createArray()
                val jsonWorkspaces = response.optJSONArray("workspaces")
                if (jsonWorkspaces != null) {
                    for (i in 0 until jsonWorkspaces.length()) {
                        val item = jsonWorkspaces.getJSONObject(i)
                        workspaces.pushMap(Arguments.createMap().apply {
                            putString("name", item.getString("name"))
                            putDouble("lastOpened", item.optDouble("lastOpened", 0.0))
                            if (item.has("running")) putBoolean("running", item.optBoolean("running"))
                            if (item.has("ephemeral")) putBoolean("ephemeral", item.optBoolean("ephemeral"))
                        })
                    }
                }
                promise.resolve(Arguments.createMap().apply {
                    putArray("workspaces", workspaces)
                })
            } catch (error: Exception) {
                promise.reject("workspace_list_failed", error.message, error)
            }
        }
    }

    @ReactMethod
    fun selectWorkspace(name: String, source: String?, promise: Promise) {
        thread(start = true, isDaemon = true, name = "NatStackWorkspaceSelect") {
            try {
                val credential = loadCredential()
                    ?: throw IllegalStateException("No mobile credentials are stored")
                val hubUrl = credential.hubUrl
                    ?: throw IllegalStateException("Stored credential is missing a hub URL")
                val selected = postJson(
                    hubUrl,
                    "/_r/s/workspaces/select",
                    JSONObject()
                        .put("deviceId", credential.deviceId)
                        .put("refreshToken", credential.refreshToken)
                        .put("name", name)
                )
                val workspaceUrl = normalizeWorkspaceServerUrl(selected.getString("serverUrl"))
                val selectedCredential = credential.copy(
                    serverUrl = workspaceUrl,
                    workspaceName = selected.optString("workspaceName", name).takeIf { it.isNotBlank() },
                )
                val grantJson = postJson(
                    selectedCredential.serverUrl,
                    "/_r/s/auth/refresh-shell",
                    JSONObject()
                        .put("deviceId", selectedCredential.deviceId)
                        .put("refreshToken", selectedCredential.refreshToken)
                )
                val finalCredential = selectedCredential.copy(
                    workspaceId = grantJson.getString("workspaceId").takeIf { it.isNotBlank() }
                        ?: throw IllegalStateException("Mobile shell grant response did not include a workspace id")
                )
                // Validate the shell grant BEFORE persisting. A rejected grant must never leave a
                // half-updated workspace-scoped credential behind, or the next launch would treat
                // it as a fully selected workspace and skip re-pairing despite having no usable grant.
                val grant = shellGrantFromJson(finalCredential, grantJson)
                saveCredential(finalCredential)
                promise.resolve(grant)
            } catch (error: Exception) {
                promise.reject("workspace_select_failed", error.message, error)
            }
        }
    }

    @ReactMethod
    fun issueConnectionGrant(promise: Promise) {
        thread(start = true, isDaemon = true, name = "NatStackConnectionGrant") {
            try {
                val credential = loadCredential()
                    ?: throw IllegalStateException("No mobile credentials are stored")
                val source = activeAppSource()
                promise.resolve(
                    if (source.isNullOrBlank()) {
                        issueShellGrant(credential)
                    } else {
                        // An app source is active: an app-grant failure must
                        // FAIL CLOSED, not silently escalate to a shell grant
                        // (which carries strictly more authority). The outer
                        // catch rejects so the bootstrap can surface the real
                        // "app unavailable / approval required" reason.
                        issueAppGrant(credential, source)
                    }
                )
            } catch (error: Exception) {
                promise.reject("grant_failed", error.message, error)
            }
        }
    }

    @ReactMethod
    fun prepareAppBundle(expectedRnHostAbi: String, platform: String, source: String?, promise: Promise) {
        thread(start = true, isDaemon = true, name = "NatStackPrepareBundle") {
            try {
                val credential = loadCredential()
                    ?: throw IllegalStateException("No mobile credentials are stored")
                val body = JSONObject()
                    .put("deviceId", credential.deviceId)
                    .put("refreshToken", credential.refreshToken)
                if (!source.isNullOrBlank()) {
                    body.put("source", source)
                }
                val bootstrapResponse = postJson(
                    credential.serverUrl,
                    "/_r/s/auth/mobile-app-bootstrap",
                    body
                )
                Log.i(TAG, "[NatStackMobileSmoke] phase=native-bundle-bootstrap-fetched")
                val bootstrap = bootstrapResponse.getJSONObject("bootstrap")
                val rnHostAbi = bootstrap.getString("rnHostAbi")
                if (rnHostAbi != expectedRnHostAbi) {
                    throw IllegalStateException("React Native host ABI mismatch: expected $expectedRnHostAbi, got $rnHostAbi")
                }
                val buildKey = bootstrap.getString("buildKey")
                val artifact = selectArtifact(bootstrap, platform)
                val artifactUrl = artifact.getString("url")
                val artifactPath = artifact.getString("path")
                val integrity = artifact.getString("integrity")
                ensureSameOriginArtifactUrl(artifactUrl, credential.serverUrl)
                val activeBundlePath = NatStackBundleStore.activeBundlePathIfMatches(
                    reactApplicationContext,
                    buildKey,
                    integrity
                )
                if (activeBundlePath != null) {
                    updateActiveAppSource(source)
                    Log.i(TAG, "[NatStackMobileSmoke] phase=native-bundle-cache-hit")
                    Log.i(TAG, "[NatStackMobileSmoke] phase=native-bundle-prepared cached=true")
                    promise.resolve(preparedBundleMap(
                        bootstrap,
                        buildKey,
                        rnHostAbi,
                        integrity,
                        platform,
                        artifactUrl,
                        artifactPath,
                        activeBundlePath
                    ))
                    return@thread
                }
                val bytes = getBytes(artifactUrl)
                verifySha256Integrity(integrity, bytes)
                val bundleFile = writeBundleFile(buildKey, artifactPath, bytes)
                updateActiveAppSource(source)
                Log.i(TAG, "[NatStackMobileSmoke] phase=native-bundle-prepared")
                promise.resolve(preparedBundleMap(
                    bootstrap,
                    buildKey,
                    rnHostAbi,
                    integrity,
                    platform,
                    artifactUrl,
                    artifactPath,
                    bundleFile.absolutePath
                ))
            } catch (error: Exception) {
                promise.reject("bundle_prepare_failed", error.message, error)
            }
        }
    }

    @ReactMethod
    fun activatePreparedAppBundle(localPath: String, buildKey: String, integrity: String, promise: Promise) {
        try {
            val changed = NatStackBundleStore.activate(reactApplicationContext, localPath, buildKey, integrity)
            Log.i(TAG, "[NatStackMobileSmoke] phase=native-bundle-activated changed=$changed")
            promise.resolve(Arguments.createMap().apply {
                putBoolean("activated", changed)
            })
            if (changed) {
                Handler(Looper.getMainLooper()).post {
                    try {
                        Log.i(TAG, "[NatStackMobileSmoke] phase=native-rn-reload-requested")
                        reloadReactNative()
                    } catch (error: Exception) {
                        Log.e(TAG, "Failed to reload React Native after bundle activation", error)
                    }
                }
            }
        } catch (error: Exception) {
            promise.reject("bundle_activate_failed", error.message, error)
        }
    }

    private fun issueShellGrant(credential: Credential): WritableMap {
        val body = JSONObject()
            .put("deviceId", credential.deviceId)
            .put("refreshToken", credential.refreshToken)
        return postJson(
            credential.serverUrl,
            "/_r/s/auth/refresh-shell",
            body
        ).let { json -> shellGrantFromJson(credential, json) }
    }

    private fun shellGrantFromJson(credential: Credential, json: JSONObject): WritableMap {
        val callerId = json.optString("callerId")
        val shellToken = json.optString("shellToken")
        val responseDeviceId = json.optString("deviceId")
        if (!isMobileShellCaller(callerId, credential.deviceId)) {
            throw IllegalStateException("Mobile shell grant response did not include this device's shell principal")
        }
        if (shellToken.isBlank()) {
            throw IllegalStateException("Mobile shell grant response did not include a shell token")
        }
        if (responseDeviceId.isNotBlank() && responseDeviceId != credential.deviceId) {
            throw IllegalStateException("Mobile shell grant response device did not match the stored credential")
        }
        return Arguments.createMap().apply {
            putString("serverUrl", credential.serverUrl)
            putString("deviceId", credential.deviceId)
            putString("callerId", callerId)
            putString("connectionGrant", shellToken)
            putString("serverId", json.getString("serverId").takeIf { it.isNotBlank() }
                ?: throw IllegalStateException("Mobile shell grant response did not include a server id"))
            json.optString("serverBootId").takeIf { it.isNotBlank() }?.let { putString("serverBootId", it) }
            putString("workspaceId", json.getString("workspaceId").takeIf { it.isNotBlank() }
                ?: throw IllegalStateException("Mobile shell grant response did not include a workspace id"))
        }
    }

    private fun issueAppGrant(credential: Credential, source: String? = null): WritableMap {
        val body = JSONObject()
            .put("deviceId", credential.deviceId)
            .put("refreshToken", credential.refreshToken)
            .put("principal", "react-native-app")
        if (!source.isNullOrBlank()) {
            body.put("source", source)
        }
        return postJson(
            credential.serverUrl,
            "/_r/s/auth/refresh-principal-grant",
            body
        ).let { json ->
            val callerId = json.optString("callerId")
            val connectionGrant = json.optString("connectionGrant")
            val responseDeviceId = json.optString("deviceId")
            if (!isWorkspaceMobileAppCaller(callerId, credential.deviceId)) {
                throw IllegalStateException("Mobile app grant response did not include a workspace mobile app principal")
            }
            if (connectionGrant.isBlank()) {
                throw IllegalStateException("Mobile app grant response did not include a connection grant")
            }
            if (responseDeviceId.isNotBlank() && responseDeviceId != credential.deviceId) {
                throw IllegalStateException("Mobile app grant response device did not match the stored credential")
            }
            Arguments.createMap().apply {
                putString("serverUrl", credential.serverUrl)
                putString("deviceId", credential.deviceId)
                putString("callerId", callerId)
                putString("connectionGrant", connectionGrant)
                if (json.has("expiresAt")) putDouble("expiresAt", json.getDouble("expiresAt"))
                putString("serverId", json.getString("serverId").takeIf { it.isNotBlank() }
                    ?: throw IllegalStateException("Mobile app grant response did not include a server id"))
                json.optString("serverBootId").takeIf { it.isNotBlank() }?.let { putString("serverBootId", it) }
                putString("workspaceId", json.getString("workspaceId").takeIf { it.isNotBlank() }
                    ?: throw IllegalStateException("Mobile app grant response did not include a workspace id"))
            }
        }
    }

    private fun activeAppSource(): String? = prefs.getString(ACTIVE_APP_SOURCE_KEY, null)
        ?.takeIf { it.isNotBlank() }

    private fun updateActiveAppSource(source: String?) {
        if (!source.isNullOrBlank()) {
            prefs.edit().putString(ACTIVE_APP_SOURCE_KEY, source).apply()
        } else {
            prefs.edit().remove(ACTIVE_APP_SOURCE_KEY).apply()
        }
    }

    private fun clearStoredCredentials() {
        prefs.edit().remove(CREDENTIAL_KEY).remove(ACTIVE_APP_SOURCE_KEY).apply()
    }

    private fun isWorkspaceMobileAppCaller(callerId: String, deviceId: String): Boolean =
        callerId.startsWith(WORKSPACE_APP_CALLER_PREFIX) && callerId.endsWith(":$deviceId")

    private fun isMobileShellCaller(callerId: String, deviceId: String): Boolean =
        callerId == "shell:$deviceId"

    private fun postJson(serverUrl: String, path: String, body: JSONObject): JSONObject {
        val connection = URL("$serverUrl$path").openConnection() as HttpURLConnection
        connection.requestMethod = "POST"
        connection.connectTimeout = HTTP_CONNECT_TIMEOUT_MS
        connection.readTimeout = JSON_POST_READ_TIMEOUT_MS
        connection.setRequestProperty("Content-Type", "application/json")
        connection.doOutput = true
        OutputStreamWriter(connection.outputStream, Charsets.UTF_8).use { writer ->
            writer.write(body.toString())
        }
        val stream = if (connection.responseCode in 200..299) connection.inputStream else connection.errorStream
        val payload = stream.bufferedReader(Charsets.UTF_8).use(BufferedReader::readText)
        val json = if (payload.isBlank()) JSONObject() else JSONObject(payload)
        if (connection.responseCode !in 200..299) {
            throw IllegalStateException(json.optString("error", "Auth request failed (${connection.responseCode})"))
        }
        return json
    }

    private fun getBytes(url: String): ByteArray {
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.requestMethod = "GET"
        connection.connectTimeout = HTTP_CONNECT_TIMEOUT_MS
        connection.readTimeout = BUNDLE_READ_TIMEOUT_MS
        val stream = if (connection.responseCode in 200..299) connection.inputStream else connection.errorStream
        val payload = stream.use { it.readBytes() }
        if (connection.responseCode !in 200..299) {
            throw IllegalStateException("Bundle artifact request failed (${connection.responseCode}): ${String(payload, Charsets.UTF_8)}")
        }
        return payload
    }

    private fun ensureSameOriginArtifactUrl(artifactUrl: String, serverUrl: String) {
        val artifact = URL(artifactUrl)
        val server = URL(serverUrl)
        val artifactProtocol = artifact.protocol.lowercase()
        val serverProtocol = server.protocol.lowercase()
        if (
            artifactProtocol != serverProtocol ||
            (artifactProtocol != "http" && artifactProtocol != "https") ||
            !artifact.host.equals(server.host, ignoreCase = true) ||
            normalizedPort(artifact) != normalizedPort(server)
        ) {
            throw IllegalStateException("React Native bundle artifact URL is outside the paired server origin")
        }
    }

    private fun selectArtifact(bootstrap: JSONObject, platform: String): JSONObject {
        val artifacts = bootstrap.getJSONArray("artifacts")
        for (index in 0 until artifacts.length()) {
            val artifact = artifacts.getJSONObject(index)
            if (artifact.optString("role") != "primary") continue
            val artifactPlatform = artifact.optString("platform")
            if (artifactPlatform == platform) return artifact
        }
        throw IllegalStateException("No primary React Native bundle artifact is available for $platform")
    }

    private fun stringArray(json: JSONObject, key: String) = Arguments.createArray().apply {
        val values = json.getJSONArray(key)
        for (index in 0 until values.length()) {
            pushString(values.getString(index))
        }
    }

    private fun preparedBundleMap(
        bootstrap: JSONObject,
        buildKey: String,
        rnHostAbi: String,
        integrity: String,
        platform: String,
        artifactUrl: String,
        artifactPath: String,
        localPath: String
    ): WritableMap = Arguments.createMap().apply {
        putString("appId", bootstrap.getString("appId"))
        putString("buildKey", buildKey)
        putString("effectiveVersion", bootstrap.optString("effectiveVersion").takeIf { it.isNotBlank() })
        putArray("capabilities", stringArray(bootstrap, "capabilities"))
        putString("rnHostAbi", rnHostAbi)
        putString("integrity", integrity)
        putString("platform", platform)
        putString("url", artifactUrl)
        putString("path", artifactPath)
        putString("localPath", localPath)
    }

    private fun verifySha256Integrity(integrity: String, bytes: ByteArray) {
        val expected = integrity.removePrefix("sha256-")
        if (expected.length != 64 || expected.any { it !in '0'..'9' && it !in 'a'..'f' && it !in 'A'..'F' }) {
            throw IllegalStateException("Unsupported React Native bundle integrity: $integrity")
        }
        val actual = MessageDigest.getInstance("SHA-256")
            .digest(bytes)
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }
        if (!actual.equals(expected, ignoreCase = true)) {
            throw IllegalStateException("React Native bundle integrity mismatch")
        }
    }

    private fun writeBundleFile(buildKey: String, artifactPath: String, bytes: ByteArray): File {
        val safeBuildKey = buildKey.replace(Regex("[^A-Za-z0-9._-]"), "_")
        val safeArtifact = artifactPath.replace(Regex("[^A-Za-z0-9._-]"), "_")
        val dir = File(reactApplicationContext.cacheDir, "natstack-rn/$safeBuildKey")
        dir.mkdirs()
        val file = File(dir, safeArtifact)
        file.writeBytes(bytes)
        return file
    }

    private fun reloadReactNative() {
        val app = reactApplicationContext.applicationContext as? ReactApplication
            ?: throw IllegalStateException("Application is not a ReactApplication")
        if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
            (app.reactHost ?: throw IllegalStateException("ReactHost is unavailable"))
                .reload("NatStack workspace app bundle activated")
        } else {
            restartApplicationProcess()
        }
    }

    private fun restartApplicationProcess() {
        val launchIntent = reactApplicationContext.packageManager
            .getLaunchIntentForPackage(reactApplicationContext.packageName)
            ?: throw IllegalStateException("Could not resolve mobile launch intent")
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        reactApplicationContext.startActivity(launchIntent)
        Runtime.getRuntime().exit(0)
    }

    private fun saveCredential(credential: Credential) {
        val json = JSONObject()
            .put("serverUrl", credential.serverUrl)
            .put("hubUrl", credential.hubUrl ?: credential.serverUrl)
            .put("workspaceName", credential.workspaceName ?: JSONObject.NULL)
            .put("deviceId", credential.deviceId)
            .put("refreshToken", credential.refreshToken)
            .put("serverId", credential.serverId)
            .put("workspaceId", credential.workspaceId)
        prefs.edit().putString(CREDENTIAL_KEY, encrypt(json.toString())).apply()
    }

    private fun loadCredential(): Credential? {
        val encrypted = prefs.getString(CREDENTIAL_KEY, null) ?: return null
        val json = JSONObject(decrypt(encrypted))
        return Credential(
            serverUrl = json.getString("serverUrl"),
            hubUrl = json.optString("hubUrl").takeIf { it.isNotBlank() },
            deviceId = json.getString("deviceId"),
            refreshToken = json.getString("refreshToken"),
            serverId = json.getString("serverId").takeIf { it.isNotBlank() }
                ?: throw IllegalStateException("Stored credential payload is missing a server id"),
            workspaceId = json.optString("workspaceId"),
            workspaceName = json.optString("workspaceName").takeIf { it.isNotBlank() },
        )
    }

    private fun encrypt(plainText: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val iv = cipher.iv
        val ciphertext = cipher.doFinal(plainText.toByteArray(Charsets.UTF_8))
        val combined = ByteArray(iv.size + ciphertext.size)
        System.arraycopy(iv, 0, combined, 0, iv.size)
        System.arraycopy(ciphertext, 0, combined, iv.size, ciphertext.size)
        return Base64.encodeToString(combined, Base64.NO_WRAP)
    }

    private fun decrypt(encoded: String): String {
        val combined = Base64.decode(encoded, Base64.NO_WRAP)
        if (combined.size <= GCM_IV_BYTES) throw IllegalStateException("Encrypted credential payload is truncated")
        val iv = combined.copyOfRange(0, GCM_IV_BYTES)
        val ciphertext = combined.copyOfRange(GCM_IV_BYTES, combined.size)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
        return String(cipher.doFinal(ciphertext), Charsets.UTF_8)
    }

    private fun secretKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val keyGenerator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        keyGenerator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build()
        )
        return keyGenerator.generateKey()
    }

    private data class Credential(
        val serverUrl: String,
        val hubUrl: String?,
        val deviceId: String,
        val refreshToken: String,
        val serverId: String,
        val workspaceId: String,
        val workspaceName: String?,
    ) {
        fun toPublicMap() = Arguments.createMap().apply {
            putString("serverUrl", serverUrl)
            hubUrl?.let { putString("hubUrl", it) }
            workspaceName?.let { putString("workspaceName", it) }
            putString("deviceId", deviceId)
            putString("serverId", serverId)
            putString("workspaceId", workspaceId)
        }
    }

    private companion object {
        const val CREDENTIAL_KEY = "credential"
        const val ACTIVE_APP_SOURCE_KEY = "activeBundle.source"
        const val TAG = "NatStackMobileHost"
        const val KEY_ALIAS = "natstack-mobile-refresh"
        const val GCM_IV_BYTES = 12
        const val GCM_TAG_BITS = 128
        const val WORKSPACE_APP_CALLER_PREFIX = "app:apps/"
        const val HTTP_CONNECT_TIMEOUT_MS = 15_000
        const val JSON_POST_READ_TIMEOUT_MS = 120_000
        const val BUNDLE_READ_TIMEOUT_MS = 30_000

        fun normalizeServerUrl(serverUrl: String): String {
            val url = URL(serverUrl.trim())
            val protocol = url.protocol.lowercase()
            if (protocol != "http" && protocol != "https") {
                throw IllegalArgumentException("Pairing server URL must use http or https")
            }
            if (url.host.isBlank() || !url.userInfo.isNullOrBlank()) {
                throw IllegalArgumentException("Pairing server URL must be an origin")
            }
            if ((url.path.isNotEmpty() && url.path != "/") || !url.query.isNullOrEmpty() || url.ref != null) {
                throw IllegalArgumentException("Pairing server URL must not include a path, query, or fragment")
            }
            val port = if (url.port >= 0) ":${url.port}" else ""
            return "$protocol://${url.host}$port"
        }

        fun normalizeWorkspaceServerUrl(serverUrl: String): String {
            val url = URL(serverUrl.trim())
            val protocol = url.protocol.lowercase()
            if (protocol != "http" && protocol != "https") {
                throw IllegalArgumentException("Workspace server URL must use http or https")
            }
            if (url.host.isBlank() || !url.userInfo.isNullOrBlank()) {
                throw IllegalArgumentException("Workspace server URL must include a host")
            }
            if (!url.query.isNullOrEmpty() || url.ref != null) {
                throw IllegalArgumentException("Workspace server URL must not include a query or fragment")
            }
            val port = if (url.port >= 0) ":${url.port}" else ""
            val path = url.path.trimEnd('/').takeIf { it.isNotBlank() && it != "/" } ?: ""
            return "$protocol://${url.host}$port$path"
        }

        fun normalizedPort(url: URL): Int = if (url.port >= 0) url.port else url.defaultPort

    }
}
