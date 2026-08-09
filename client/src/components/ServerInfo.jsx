export default function ServerInfo({ ipInfo }) {
    if (!ipInfo) return null;
    return (
      <div className="mt-4 px-4 py-2 bg-[#0f0f1f] border border-[#1e1e3f] rounded-full">
        <p className="text-gray-500 text-xs text-center tracking-wide">
          🌐 {ipInfo.processedString}
        </p>
      </div>
    );
  }