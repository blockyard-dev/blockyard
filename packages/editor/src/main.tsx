import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

const host = document.getElementById('root');
if (!host) throw new Error('index.html 少了 #root');

// StrictMode 在開發時會把 effect 跑兩次；WorkspaceView 的 cleanup 會 dispose，
// 所以那是安全的——反過來說，如果哪天畫面出現兩個工作區，就是 cleanup 漏了。
createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
