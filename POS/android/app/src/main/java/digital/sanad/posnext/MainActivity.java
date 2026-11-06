package digital.sanad.posnext;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ClassicPrinterPlugin.class);
        registerPlugin(TcpPrinterPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
