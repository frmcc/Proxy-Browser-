/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Search } from 'lucide-react';

export default function App() {
  const [inputUrl, setInputUrl] = useState('');

  const handleGo = (e?: React.FormEvent) => {
    e?.preventDefault();
    let url = inputUrl.trim();
    if (!url) return;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      if (url.includes('.') && !url.includes(' ')) {
        url = 'https://' + url;
      } else {
        url = 'https://www.google.com/search?q=' + encodeURIComponent(url);
      }
    }
    window.location.href = `/api/proxy?url=${encodeURIComponent(url)}`;
  };

  return (
    <div className="flex flex-col h-screen bg-gray-100 font-sans items-center justify-center p-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-xl p-8 text-center">
        <div className="w-16 h-16 bg-blue-500 rounded-2xl mx-auto flex items-center justify-center mb-6 shadow-lg">
          <span className="text-white text-3xl font-bold">F</span>
        </div>
        <h1 className="text-2xl font-bold text-gray-800 mb-2">Focus Browser</h1>
        <p className="text-gray-500 mb-8 text-sm">Media and downloads are disabled to help you focus.</p>
        
        <form onSubmit={handleGo} className="flex items-center bg-gray-50 rounded-xl px-4 py-3 border border-gray-200 focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-200 transition-all">
          <Search size={20} className="text-gray-400 mr-3 shrink-0" />
          <input
            type="text"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            className="w-full bg-transparent outline-none text-gray-700"
            placeholder="Search or enter website name"
            autoCapitalize="none"
            autoCorrect="off"
          />
        </form>
      </div>
    </div>
  );
}
