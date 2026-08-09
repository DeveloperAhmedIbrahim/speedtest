import { useEffect, useRef } from "react";

export default function Gauge({ value, color = "#06b6d4", isRunning, state, onStart }) {
  const canvasRef = useRef(null);

  const getMax = (v) => {
    if (v < 10) return 10;
    if (v < 50) return 50;
    if (v < 100) return 100;
    if (v < 250) return 250;
    if (v < 500) return 500;
    return 1000;
  };

  const dynamicMax = getMax(value);
  const ticks = [0, 10, 50, 100, 250, 500, 1000];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const size = 280;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = size + "px";
    canvas.style.height = size + "px";
    ctx.scale(dpr, dpr);

    const cx = size / 2;
    const cy = size / 2 + 15;
    const r = 100;
    const startAngle = Math.PI * 0.75;
    const totalAngle = Math.PI * 1.5;

    ctx.clearRect(0, 0, size, size);

    // Background track
    ctx.beginPath();
    ctx.arc(cx, cy, r, startAngle, startAngle + totalAngle);
    ctx.strokeStyle = "#1a1a2e";
    ctx.lineWidth = 16;
    ctx.lineCap = "round";
    ctx.stroke();

    // Progress arc
    const progress = Math.min(value / dynamicMax, 1);
    if (progress > 0) {
      const grad = ctx.createLinearGradient(cx - r, cy, cx + r, cy);
      grad.addColorStop(0, color + "66");
      grad.addColorStop(1, color);
      ctx.beginPath();
      ctx.arc(cx, cy, r, startAngle, startAngle + progress * totalAngle);
      ctx.strokeStyle = grad;
      ctx.lineWidth = 16;
      ctx.lineCap = "round";
      ctx.shadowColor = color;
      ctx.shadowBlur = 20;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // Ticks + labels
    ticks.forEach((tick) => {
      const angle = startAngle + (tick / 1000) * totalAngle;
      const x1 = cx + (r - 10) * Math.cos(angle);
      const y1 = cy + (r - 10) * Math.sin(angle);
      const x2 = cx + (r + 4) * Math.cos(angle);
      const y2 = cy + (r + 4) * Math.sin(angle);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = "#2a2a4a";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      const lx = cx + (r - 24) * Math.cos(angle);
      const ly = cy + (r - 24) * Math.sin(angle);
      ctx.fillStyle = "#3a3a5a";
      ctx.font = "9px Segoe UI";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(tick === 1000 ? "1K" : tick, lx, ly);
    });

    // Speed value
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold ${value >= 100 ? "36px" : "42px"} Segoe UI`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(value.toFixed(2), cx, cy + 5);

    // Mbps
    ctx.fillStyle = color;
    ctx.font = "bold 12px Segoe UI";
    ctx.fillText("Mbps", cx, cy + 36);

  }, [value, dynamicMax, color]);

  const btnLabel = isRunning ? null : state === "done" ? "RETRY" : "GO";

  return (
    <div className="relative flex items-center justify-center" style={{ width: 280, height: 280 }}>
      <canvas ref={canvasRef} className="absolute top-0 left-0" />

      {/* Center Button — inside gauge */}
      <div
        className="absolute flex items-center justify-center"
        style={{ bottom: 18, left: "50%", transform: "translateX(-50%)" }}
      >
        <button
          onClick={!isRunning ? onStart : undefined}
          disabled={isRunning}
          className="w-16 h-16 rounded-full font-black text-sm tracking-widest transition-all duration-300 cursor-pointer disabled:cursor-default flex items-center justify-center"
          style={{
            border: `2.5px solid ${color}`,
            color: isRunning ? color : "#0a0a0f",
            background: isRunning ? "transparent" : color,
            boxShadow: `0 0 20px ${color}66`,
          }}
        >
          {isRunning
            ? <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
            : btnLabel
          }
        </button>
      </div>
    </div>
  );
}