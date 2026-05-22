package com.natstack.mobile

import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.os.Process
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import kotlin.concurrent.thread

class WebViewCdpProxyModule(
    reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
    private val lock = Any()
    private var proxy: ProxyState? = null

    override fun getName(): String = "WebViewCdpProxy"

    @ReactMethod
    fun start(promise: Promise) {
        synchronized(lock) {
            proxy?.let {
                promise.resolve(it.toMap())
                return
            }
        }

        val socketName = "webview_devtools_remote_${Process.myPid()}"
        val server = try {
            ServerSocket().apply {
                reuseAddress = false
                bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 16)
            }
        } catch (error: Exception) {
            promise.reject("bind_failed", "Could not bind Android WebView CDP proxy", error)
            return
        }

        val state = ProxyState(
            server = server,
            port = server.localPort,
            socketName = socketName,
        )
        synchronized(lock) {
            proxy = state
        }
        state.acceptThread = thread(
            start = true,
            isDaemon = true,
            name = "NatStackWebViewCdpProxy",
        ) {
            runAcceptLoop(state)
        }
        Log.i(TAG, "Android WebView CDP proxy listening on 127.0.0.1:${state.port} -> $socketName")
        promise.resolve(state.toMap())
    }

    @ReactMethod
    fun stop(promise: Promise) {
        stopActiveProxy()
        promise.resolve(null)
    }

    override fun invalidate() {
        stopActiveProxy()
        super.invalidate()
    }

    private fun stopActiveProxy() {
        val active = synchronized(lock) {
            val current = proxy
            proxy = null
            current
        }
        active?.closed = true
        try {
            active?.server?.close()
        } catch (_: Exception) {
        }
    }

    private fun runAcceptLoop(state: ProxyState) {
        while (!state.closed) {
            val tcpClient = try {
                state.server.accept()
            } catch (_: SocketException) {
                return
            } catch (error: Exception) {
                if (!state.closed) Log.w(TAG, "Android WebView CDP proxy accept failed", error)
                return
            }
            thread(
                start = true,
                isDaemon = true,
                name = "NatStackWebViewCdpProxyClient",
            ) {
                handleClient(state, tcpClient)
            }
        }
    }

    private fun handleClient(state: ProxyState, tcpClient: Socket) {
        tcpClient.use { client ->
            val localSocket = LocalSocket()
            try {
                localSocket.connect(
                    LocalSocketAddress(state.socketName, LocalSocketAddress.Namespace.ABSTRACT)
                )
            } catch (error: Exception) {
                Log.w(TAG, "Could not connect to Android WebView CDP socket ${state.socketName}", error)
                return
            }
            localSocket.use { devtools ->
                val clientToDevtools = thread(
                    start = true,
                    isDaemon = true,
                    name = "NatStackWebViewCdpProxyUpstream",
                ) {
                    pipe(client.getInputStream(), devtools.outputStream)
                }
                val devtoolsToClient = thread(
                    start = true,
                    isDaemon = true,
                    name = "NatStackWebViewCdpProxyDownstream",
                ) {
                    pipe(devtools.inputStream, client.getOutputStream())
                }
                clientToDevtools.join()
                try {
                    devtools.shutdownOutput()
                } catch (_: Exception) {
                }
                devtoolsToClient.join()
            }
        }
    }

    private fun pipe(input: InputStream, output: OutputStream) {
        val buffer = ByteArray(BUFFER_SIZE)
        try {
            while (true) {
                val read = input.read(buffer)
                if (read <= 0) return
                output.write(buffer, 0, read)
                output.flush()
            }
        } catch (_: Exception) {
        }
    }

    private class ProxyState(
        val server: ServerSocket,
        val port: Int,
        val socketName: String,
    ) {
        @Volatile
        var closed = false
        var acceptThread: Thread? = null

        fun toMap() = Arguments.createMap().apply {
            putInt("port", port)
            putString("socketName", socketName)
            putString("host", "127.0.0.1")
        }
    }

    private companion object {
        const val TAG = "NatStackWebViewCdp"
        const val BUFFER_SIZE = 16 * 1024
    }
}
