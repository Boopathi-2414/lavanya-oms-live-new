import { useState, useEffect, useRef } from 'react';

// Tiny event bus so any component can fire toast()
const listeners = new Set();

export function toast(msg, type = 'info') {
  listeners.forEach((fn) => fn(msg, type));
}

export default function ToastContainer() {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);

  useEffect(() => {
    const handler = (msg, type) => {
      const id = ++idRef.current;
      setToasts((prev) => [...prev.slice(-2), { id, msg, type }]);
      setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3500);
    };
    listeners.add(handler);
    return () => listeners.delete(handler);
  }, []);

  return (
    <div id="toast-container">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.type}`}>{t.msg}</div>
      ))}
    </div>
  );
}
