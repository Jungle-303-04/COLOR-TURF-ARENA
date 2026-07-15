import { useEffect, useState } from "react";
import QRCode from "qrcode";

interface QrCodeProps {
  value: string;
  label: string;
  size?: number;
}

export const QrCode = ({ value, label, size = 240 }: QrCodeProps) => {
  const [source, setSource] = useState("");

  useEffect(() => {
    let active = true;
    void QRCode.toDataURL(value, {
      width: size,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#080811", light: "#ffffff" },
    }).then((dataUrl) => {
      if (active) setSource(dataUrl);
    });
    return () => { active = false; };
  }, [size, value]);

  return source
    ? <img className="qr-image" src={source} width={size} height={size} alt={`${label} QR 코드`} />
    : <div className="qr-placeholder" style={{ width: size, height: size }}>QR 생성 중</div>;
};

