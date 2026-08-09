export default function Results({ download, upload, ping, jitter }) {
    return (
      <div className="grid grid-cols-2 gap-4 w-full max-w-sm mt-6">
        {/* Download */}
        <div className="bg-[#0f0f1f] border border-[#1e1e3f] rounded-2xl p-4 flex flex-col items-center gap-1">
          <div className="flex items-center gap-2 text-cyan-400">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M12 5v14M5 12l7 7 7-7"/>
            </svg>
            <span className="text-xs uppercase tracking-widest text-gray-400">Download</span>
          </div>
          <span className="text-3xl font-bold text-white">
            {download ?? <span className="text-gray-600">—</span>}
          </span>
          <span className="text-xs text-gray-500">Mbps</span>
        </div>
  
        {/* Upload */}
        <div className="bg-[#0f0f1f] border border-[#1e1e3f] rounded-2xl p-4 flex flex-col items-center gap-1">
          <div className="flex items-center gap-2 text-purple-400">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M12 19V5M5 12l7-7 7 7"/>
            </svg>
            <span className="text-xs uppercase tracking-widest text-gray-400">Upload</span>
          </div>
          <span className="text-3xl font-bold text-white">
            {upload ?? <span className="text-gray-600">—</span>}
          </span>
          <span className="text-xs text-gray-500">Mbps</span>
        </div>
  
        {/* Ping */}
        <div className="bg-[#0f0f1f] border border-[#1e1e3f] rounded-2xl p-4 flex flex-col items-center gap-1">
          <div className="flex items-center gap-2 text-yellow-400">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>
            </svg>
            <span className="text-xs uppercase tracking-widest text-gray-400">Ping</span>
          </div>
          <span className="text-3xl font-bold text-white">
            {ping ?? <span className="text-gray-600">—</span>}
          </span>
          <span className="text-xs text-gray-500">ms</span>
        </div>
  
        {/* Jitter */}
        <div className="bg-[#0f0f1f] border border-[#1e1e3f] rounded-2xl p-4 flex flex-col items-center gap-1">
          <div className="flex items-center gap-2 text-green-400">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M2 12h4l3-8 4 16 3-8 4 0"/>
            </svg>
            <span className="text-xs uppercase tracking-widest text-gray-400">Jitter</span>
          </div>
          <span className="text-3xl font-bold text-white">
            {jitter ?? <span className="text-gray-600">—</span>}
          </span>
          <span className="text-xs text-gray-500">ms</span>
        </div>
      </div>
    );
  }