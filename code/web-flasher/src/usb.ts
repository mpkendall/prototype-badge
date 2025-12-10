// usb.ts

let port: SerialPort | null = null;

const btn = document.getElementById("connect-button") as HTMLButtonElement;
const filters = [
    { usbVendorId: 0x2E8A, usbProductId: 0x0005 }
]

if (btn) {
    btn.addEventListener("click", async () => {
        if (!("serial" in navigator)) {
            console.error("Web Serial API not supported.");
            return;
        }

        // If we're already connected, disconnect
        if (port && port.readable) {
            try {
                await port.close();
                port = null;
                setDisconnectedAppearance();
                console.log("Disconnected.");
            } catch (err) {
                console.error("Disconnect failed:", err);
            }
            return;
        }

        // Otherwise, attempt connection
        try {
            port = await (navigator as any).serial.requestPort({ filters });
            await port.open({ baudRate: 115200 });

            setConnectedAppearance();
            console.log("Connected:", port);
        } catch (err) {
            console.log("Connection failed or cancelled:", err);
        }
    });
}

// UI helpers

function setConnectedAppearance() {
    btn.textContent = "Disconnect";
    btn.classList.remove("bg-green-700", "hover:bg-green-600");
    btn.classList.add("bg-red-900", "hover:bg-red-700");
    /* 
    btn.classList.remove("bg-red-900", "hover:bg-red-700");
    btn.classList.add("bg-green-700", "hover:bg-green-600");
    */
}

function setDisconnectedAppearance() {
    btn.textContent = "Connect";
    btn.classList.remove("bg-red-900", "hover:bg-red-700");
    btn.classList.add("bg-green-700", "hover:bg-green-600");
}
