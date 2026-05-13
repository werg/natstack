package com.natstack.mobile

import android.content.Intent
import android.os.Build
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import java.io.BufferedReader
import java.io.OutputStream
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.SocketException
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import kotlin.concurrent.thread

class OAuthLoopbackModule(
    reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
    private val lock = Any()
    private var listener: Listener? = null

    override fun getName(): String = "OAuthLoopback"

    @ReactMethod
    fun start(options: ReadableMap, promise: Promise) {
        synchronized(lock) {
            if (listener != null) {
                promise.reject("already_running", "An OAuth loopback listener is already running")
                return
            }
        }

        val host = options.getString("host") ?: "localhost"
        val port = if (options.hasKey("port")) options.getInt("port") else 0
        val callbackPath = options.getString("callbackPath") ?: "/oauth/callback"
        val expectedState = options.getString("expectedState") ?: ""
        val timeoutMs = if (options.hasKey("timeoutMs")) options.getDouble("timeoutMs").toLong() else 600_000L

        if (host != "localhost" && host != "127.0.0.1") {
            promise.reject("invalid_host", "OAuth loopback host must be localhost or 127.0.0.1")
            return
        }
        if (port < 1 || port > 65535) {
            promise.reject("invalid_port", "OAuth loopback requires a fixed port")
            return
        }
        if (!callbackPath.startsWith("/")) {
            promise.reject("invalid_callback_path", "OAuth callback path must start with /")
            return
        }
        if (expectedState.isBlank()) {
            promise.reject("invalid_state", "OAuth loopback requires an expected state")
            return
        }

        val sockets = try {
            bindLoopbackSockets(host, port)
        } catch (error: Exception) {
            promise.reject("bind_failed", "Could not bind OAuth loopback listener on $host:$port", error)
            return
        }

        try {
            startKeepAliveService()
        } catch (error: Exception) {
            closeQuietly(sockets)
            promise.reject("keepalive_failed", "Could not keep NatStack active for browser sign-in", error)
            return
        }

        val next = Listener(
            sockets = sockets,
            host = host,
            port = port,
            callbackPath = callbackPath,
            expectedState = expectedState,
            deadlineMs = System.currentTimeMillis() + timeoutMs.coerceAtLeast(1_000),
        )
        synchronized(lock) {
            listener = next
        }
        for (bound in sockets) {
            next.threads += thread(
                start = true,
                isDaemon = true,
                name = "NatStackOAuthLoopback-${bound.label}",
            ) {
                runListener(next, bound)
            }
        }
        Log.i(TAG, "OAuth loopback listening on ${sockets.joinToString { it.label }} for $host:$port$callbackPath")
        promise.resolve(null)
    }

    @ReactMethod
    fun wait(promise: Promise) {
        val current = synchronized(lock) { listener }
        if (current == null) {
            promise.reject("not_running", "No OAuth loopback listener is running")
            return
        }
        synchronized(current) {
            if (current.waitPromise != null) {
                promise.reject("wait_already_pending", "An OAuth loopback wait is already pending")
                return
            }
            current.waitPromise = promise
            current.completedResult?.let {
                current.waitPromise = null
                promise.resolve(it)
                finish(current)
            }
            current.completedError?.let {
                current.waitPromise = null
                promise.reject(it.code, it.message)
                finish(current)
            }
        }
    }

    @ReactMethod
    fun stop(promise: Promise) {
        val current = synchronized(lock) {
            val active = listener
            listener = null
            active
        }
        if (current != null) {
            current.closed = true
            closeQuietly(current.sockets)
            stopKeepAliveService()
            rejectWait(current, "stopped", "OAuth loopback listener stopped")
        }
        promise.resolve(null)
    }

    override fun invalidate() {
        val current = synchronized(lock) {
            val active = listener
            listener = null
            active
        }
        if (current != null) {
            current.closed = true
            closeQuietly(current.sockets)
            stopKeepAliveService()
            rejectWait(current, "stopped", "OAuth loopback listener stopped")
        }
        super.invalidate()
    }

    private fun bindLoopbackSockets(host: String, port: Int): List<BoundSocket> {
        val addresses = if (host == "localhost") {
            listOf("127.0.0.1", "::1")
        } else {
            listOf(host)
        }
        val sockets = mutableListOf<BoundSocket>()
        val failures = mutableListOf<String>()
        for (address in addresses) {
            try {
                val socket = ServerSocket().apply {
                    reuseAddress = false
                    soTimeout = 1_000
                    bind(InetSocketAddress(InetAddress.getByName(address), port), 1)
                }
                sockets += BoundSocket(socket, address)
            } catch (error: Exception) {
                failures += "$address: ${error.message ?: error.javaClass.simpleName}"
                Log.w(TAG, "Could not bind OAuth loopback listener on $address:$port", error)
            }
        }
        if (sockets.isEmpty()) {
            throw IllegalStateException(failures.joinToString("; "))
        }
        return sockets
    }

    private fun runListener(active: Listener, bound: BoundSocket) {
        while (!active.closed) {
            if (System.currentTimeMillis() > active.deadlineMs) {
                rejectWait(active, "timeout", "OAuth loopback listener timed out")
                finish(active)
                return
            }
            val client = try {
                bound.socket.accept()
            } catch (_: SocketTimeoutException) {
                continue
            } catch (_: SocketException) {
                if (!active.closed) {
                    rejectWait(active, "listener_failed", "OAuth loopback listener closed unexpectedly")
                    finish(active)
                }
                return
            } catch (error: Exception) {
                if (!active.closed) rejectWait(active, "listener_failed", error.message ?: "OAuth loopback listener failed")
                finish(active)
                return
            }
            if (handleClient(active, client, bound)) return
        }
    }

    private fun handleClient(active: Listener, client: Socket, bound: BoundSocket): Boolean {
        client.use { socket ->
            val reader = BufferedReader(InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8))
            val requestLine = reader.readLine() ?: ""
            if (requestLine.isBlank()) {
                Log.i(TAG, "Ignoring empty OAuth loopback request on ${bound.label}")
                return false
            }
            while (true) {
                val line = reader.readLine() ?: break
                if (line.isEmpty()) break
            }

            val target = requestLine.split(" ").getOrNull(1) ?: ""
            val uri = try {
                URI(target)
            } catch (_: Exception) {
                respond(socket.getOutputStream(), 400, "OAuth callback could not be parsed.")
                rejectWait(active, "invalid_callback", "OAuth callback could not be parsed")
                finish(active)
                return true
            }
            val path = uri.path ?: ""
            val params = parseQuery(uri.rawQuery ?: "")
            val state = params["state"] ?: ""
            val code = params["code"]
            val error = params["error"]
            val rawUrl = "http://${active.host}:${active.port}$target"

            if (path != active.callbackPath) {
                Log.w(TAG, "OAuth callback path mismatch: $path expected ${active.callbackPath}")
                respond(socket.getOutputStream(), 404, "OAuth callback path did not match.")
                rejectWait(active, "path_mismatch", "OAuth callback path did not match")
                finish(active)
                return true
            }
            if (state != active.expectedState) {
                Log.w(TAG, "OAuth callback state mismatch")
                respond(socket.getOutputStream(), 400, "OAuth state mismatch.")
                rejectWait(active, "state_mismatch", "OAuth state mismatch")
                finish(active)
                return true
            }
            if (error != null) {
                respond(socket.getOutputStream(), 400, "The provider denied the connection. Return to NatStack.")
                resolveWait(active, rawUrl, code, state, error)
                finish(active)
                return true
            }
            if (code.isNullOrBlank()) {
                respond(socket.getOutputStream(), 400, "Missing authorization code. Return to NatStack.")
                rejectWait(active, "missing_code", "OAuth callback did not include an authorization code")
                finish(active)
                return true
            }

            respond(socket.getOutputStream(), 200, "Connection complete. You can return to NatStack.")
            resolveWait(active, rawUrl, code, state, null)
            finish(active)
            return true
        }
    }

    private fun parseQuery(query: String): Map<String, String> {
        if (query.isBlank()) return emptyMap()
        val params = mutableMapOf<String, String>()
        for (part in query.split("&")) {
            if (part.isEmpty()) continue
            val eq = part.indexOf("=")
            val key = if (eq >= 0) part.substring(0, eq) else part
            val value = if (eq >= 0) part.substring(eq + 1) else ""
            params[decode(key)] = decode(value)
        }
        return params
    }

    private fun decode(value: String): String =
        URLDecoder.decode(value, StandardCharsets.UTF_8.name())

    private fun respond(output: OutputStream, status: Int, message: String) {
        val reason = if (status == 200) "OK" else "Bad Request"
        val body = """
            <!doctype html>
            <html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
            <body><p>${escapeHtml(message)}</p></body></html>
        """.trimIndent()
        val bytes = body.toByteArray(StandardCharsets.UTF_8)
        val headers = "HTTP/1.1 $status $reason\r\n" +
            "Content-Type: text/html; charset=utf-8\r\n" +
            "Content-Length: ${bytes.size}\r\n" +
            "Cache-Control: no-store\r\n" +
            "Connection: close\r\n\r\n"
        output.write(headers.toByteArray(StandardCharsets.UTF_8))
        output.write(bytes)
        output.flush()
    }

    private fun escapeHtml(value: String): String =
        value
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace("\"", "&quot;")

    private fun resolveWait(active: Listener, rawUrl: String, code: String?, state: String, error: String?) {
        val result = Arguments.createMap().apply {
            putString("url", rawUrl)
            if (code != null) putString("code", code)
            putString("state", state)
            if (error != null) putString("error", error)
        }
        synchronized(active) {
            val promise = active.waitPromise
            if (promise == null) {
                active.completedResult = result
            } else {
                active.waitPromise = null
                promise.resolve(result)
            }
        }
    }

    private fun rejectWait(active: Listener, code: String, message: String) {
        synchronized(active) {
            val promise = active.waitPromise
            if (promise == null) {
                active.completedError = PendingError(code, message)
            } else {
                active.waitPromise = null
                promise.reject(code, message)
            }
        }
    }

    private fun finish(active: Listener) {
        active.closed = true
        closeQuietly(active.sockets)
        stopKeepAliveService()
        synchronized(lock) {
            if (listener === active) listener = null
        }
    }

    private fun startKeepAliveService() {
        val intent = Intent(reactApplicationContext, OAuthLoopbackKeepAliveService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            reactApplicationContext.startForegroundService(intent)
        } else {
            reactApplicationContext.startService(intent)
        }
    }

    private fun stopKeepAliveService() {
        try {
            reactApplicationContext.stopService(Intent(reactApplicationContext, OAuthLoopbackKeepAliveService::class.java))
        } catch (error: Exception) {
            Log.w(TAG, "Could not stop OAuth loopback foreground keepalive", error)
        }
    }

    private fun closeQuietly(sockets: List<BoundSocket>) {
        for (bound in sockets) {
            try {
                bound.socket.close()
            } catch (_: Exception) {
            }
        }
    }

    private data class BoundSocket(val socket: ServerSocket, val label: String)
    private data class PendingError(val code: String, val message: String)

    private class Listener(
        val sockets: List<BoundSocket>,
        val host: String,
        val port: Int,
        val callbackPath: String,
        val expectedState: String,
        val deadlineMs: Long,
    ) {
        @Volatile var closed = false
        val threads = mutableListOf<Thread>()
        var waitPromise: Promise? = null
        var completedResult: com.facebook.react.bridge.WritableMap? = null
        var completedError: PendingError? = null
    }

    companion object {
        private const val TAG = "OAuthLoopback"
    }
}
