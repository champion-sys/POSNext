package digital.sanad.posnext;

import android.util.Base64;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * Raw printing over TCP, port 9100 on nearly every network printer. Each job opens its
 * own socket: these printers serve one client at a time, and an idle socket goes stale
 * with no signal when the printer sleeps or the Wi-Fi roams.
 */
@CapacitorPlugin(name = "TcpPrinter")
public class TcpPrinterPlugin extends Plugin {

    private static final int DEFAULT_PORT = 9100;
    private static final int DEFAULT_CONNECT_TIMEOUT_MS = 5000;
    private static final int DEFAULT_WRITE_TIMEOUT_MS = 60000;
    private static final int DRAIN_TIMEOUT_MS = 1000;

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService watchdog = Executors.newSingleThreadScheduledExecutor();

    @PluginMethod
    public void probe(PluginCall call) {
        String host = call.getString("host");
        if (host == null) {
            call.reject("Missing host");
            return;
        }
        io.execute(() -> {
            try (Socket ignored = open(call, host)) {
                call.resolve();
            } catch (IOException error) {
                call.reject("Could not reach the printer", error);
            }
        });
    }

    @PluginMethod
    public void send(PluginCall call) {
        String host = call.getString("host");
        String data = call.getString("data");
        if (host == null || data == null) {
            call.reject("Missing host or data");
            return;
        }
        io.execute(() -> {
            try (Socket socket = open(call, host)) {
                write(socket, Base64.decode(data, Base64.NO_WRAP), call.getInt("writeTimeoutMs", DEFAULT_WRITE_TIMEOUT_MS));
                call.resolve();
            } catch (IOException | IllegalArgumentException error) {
                call.reject("Could not send to the printer", error);
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        io.shutdownNow();
        watchdog.shutdownNow();
    }

    private Socket open(PluginCall call, String host) throws IOException {
        InetSocketAddress address = new InetSocketAddress(host, call.getInt("port", DEFAULT_PORT));
        Socket socket = new Socket();
        try {
            socket.connect(address, call.getInt("connectTimeoutMs", DEFAULT_CONNECT_TIMEOUT_MS));
            socket.setTcpNoDelay(true);
            return socket;
        } catch (IOException error) {
            closeQuietly(socket);
            throw error;
        }
    }

    /** A printer out of paper stops reading, and a blocked write has no timeout of its own. */
    private void write(Socket socket, byte[] bytes, int writeTimeoutMs) throws IOException {
        ScheduledFuture<?> deadline = watchdog.schedule(() -> closeQuietly(socket), writeTimeoutMs, TimeUnit.MILLISECONDS);
        try {
            OutputStream output = socket.getOutputStream();
            output.write(bytes);
            output.flush();
            socket.shutdownOutput();
            drain(socket);
        } finally {
            deadline.cancel(false);
        }
    }

    /** Closing with unread status bytes resets the connection and can cut the receipt short. */
    private void drain(Socket socket) throws IOException {
        socket.setSoTimeout(DRAIN_TIMEOUT_MS);
        InputStream input = socket.getInputStream();
        byte[] ignored = new byte[64];
        try {
            while (input.read(ignored) != -1) {
                continue;
            }
        } catch (SocketTimeoutException expected) {
            // The printer keeps the socket open while it prints
        }
    }

    private void closeQuietly(Socket socket) {
        try {
            socket.close();
        } catch (IOException ignored) {
            // Already closed, which is the goal
        }
    }
}
