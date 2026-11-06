package digital.sanad.posnext;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.os.Build;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Bluetooth Classic Serial Port Profile, which most cheap thermal printers speak
 * instead of BLE. Printers are paired in Android's settings, so this only lists
 * bonded devices and never scans.
 */
@CapacitorPlugin(
    name = "ClassicPrinter",
    permissions = { @Permission(alias = "bluetooth", strings = { Manifest.permission.BLUETOOTH_CONNECT }) }
)
public class ClassicPrinterPlugin extends Plugin {

    private static final UUID SPP_UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");

    // Sockets block, and plugin methods share one thread with every other plugin
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    private volatile BluetoothSocket socket;
    private volatile OutputStream output;

    @PluginMethod
    public void listBonded(PluginCall call) {
        runWithPermission(call);
    }

    @PluginMethod
    public void connect(PluginCall call) {
        runWithPermission(call);
    }

    @PluginMethod
    public void write(PluginCall call) {
        String data = call.getString("data");
        if (data == null) {
            call.reject("Missing data");
            return;
        }
        io.execute(() -> {
            OutputStream stream = output;
            if (stream == null) {
                call.reject("Printer is not connected");
                return;
            }
            try {
                stream.write(Base64.decode(data, Base64.NO_WRAP));
                stream.flush();
                call.resolve();
            } catch (IOException | IllegalArgumentException error) {
                call.reject("Could not send to the printer", error);
            }
        });
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        closeSocket();
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        closeSocket();
        io.shutdownNow();
    }

    private void runWithPermission(PluginCall call) {
        if (isPermissionMissing()) {
            requestPermissionForAlias("bluetooth", call, "afterPermission");
        } else {
            run(call);
        }
    }

    @PermissionCallback
    private void afterPermission(PluginCall call) {
        if (isPermissionMissing()) {
            call.reject("Bluetooth permission denied", "PERMISSION_DENIED");
        } else {
            run(call);
        }
    }

    private boolean isPermissionMissing() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && getPermissionState("bluetooth") != PermissionState.GRANTED;
    }

    private void run(PluginCall call) {
        BluetoothManager manager = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
        if (adapter == null || !adapter.isEnabled()) {
            call.reject("Bluetooth is off", "BLUETOOTH_OFF");
        } else if ("connect".equals(call.getMethodName())) {
            openSocket(call, adapter);
        } else {
            resolveBondedDevices(call, adapter);
        }
    }

    @SuppressLint("MissingPermission")
    private void resolveBondedDevices(PluginCall call, BluetoothAdapter adapter) {
        JSArray devices = new JSArray();
        for (BluetoothDevice device : adapter.getBondedDevices()) {
            JSObject entry = new JSObject();
            entry.put("address", device.getAddress());
            entry.put("name", device.getName());
            entry.put("type", typeName(device.getType()));
            devices.put(entry);
        }
        JSObject result = new JSObject();
        result.put("devices", devices);
        call.resolve(result);
    }

    private String typeName(int type) {
        switch (type) {
            case BluetoothDevice.DEVICE_TYPE_CLASSIC:
                return "classic";
            case BluetoothDevice.DEVICE_TYPE_LE:
                return "le";
            case BluetoothDevice.DEVICE_TYPE_DUAL:
                return "dual";
            default:
                return "unknown";
        }
    }

    private void openSocket(PluginCall call, BluetoothAdapter adapter) {
        String address = call.getString("address");
        if (address == null) {
            call.reject("Missing address");
            return;
        }
        io.execute(() -> {
            closeSocket();
            try {
                BluetoothSocket opened = open(adapter, adapter.getRemoteDevice(address));
                output = opened.getOutputStream();
                socket = opened;
                watchForDrop(opened, address);
                call.resolve();
            } catch (IOException | IllegalArgumentException | SecurityException error) {
                closeSocket();
                call.reject("Could not connect to the printer", error);
            }
        });
    }

    @SuppressLint("MissingPermission")
    private BluetoothSocket open(BluetoothAdapter adapter, BluetoothDevice device) throws IOException {
        cancelDiscovery(adapter);
        BluetoothSocket secure = device.createRfcommSocketToServiceRecord(SPP_UUID);
        try {
            secure.connect();
            return secure;
        } catch (IOException error) {
            closeQuietly(secure);
        }
        // Printers with no pairing PIN often refuse an authenticated link
        BluetoothSocket insecure = device.createInsecureRfcommSocketToServiceRecord(SPP_UUID);
        try {
            insecure.connect();
            return insecure;
        } catch (IOException error) {
            closeQuietly(insecure);
            throw error;
        }
    }

    @SuppressLint("MissingPermission")
    private void cancelDiscovery(BluetoothAdapter adapter) {
        try {
            // A running discovery slows RFCOMM connections down until they time out
            adapter.cancelDiscovery();
        } catch (SecurityException ignored) {
            // Needs the scan permission, which only BLE pairing asks for
        }
    }

    /** RFCOMM reports a dropped link only through a read, and printers rarely send anything. */
    private void watchForDrop(BluetoothSocket watched, String address) {
        Thread watcher = new Thread(
            () -> {
                try {
                    InputStream input = watched.getInputStream();
                    byte[] ignored = new byte[64];
                    while (input.read(ignored) != -1) {
                        continue;
                    }
                } catch (IOException ignored) {
                    // The link is gone, which is what this thread waits for
                }
                if (watched == socket) {
                    closeSocket();
                    JSObject event = new JSObject();
                    event.put("address", address);
                    notifyListeners("disconnected", event);
                }
            },
            "classic-printer-watch"
        );
        watcher.setDaemon(true);
        watcher.start();
    }

    private void closeSocket() {
        BluetoothSocket current = socket;
        socket = null;
        output = null;
        if (current != null) {
            closeQuietly(current);
        }
    }

    private void closeQuietly(BluetoothSocket target) {
        try {
            target.close();
        } catch (IOException ignored) {
            // Already closed, which is the goal
        }
    }
}
