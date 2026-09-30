import { useEffect, useRef, useState } from 'react';
import App from './App.jsx';
import { getClient } from './supabase.js';
import { version } from '../package.json';
const UID = import.meta.env.VITE_AUTHORIZED_UID;
const TEST = import.meta.env.VITE_ENVIRONMENT !== 'production';
export default function AuthGate() {
  const [user,setUser]=useState(null), [checking,setChecking]=useState(true), [busy,setBusy]=useState(false);
  const [error,setError]=useState(''), [email,setEmail]=useState(''), [password,setPassword]=useState('');
  const serial=useRef(0);
  useEffect(()=>{
    let live=true, subscription;
    getClient().then(async client=>{
      if(!live)return;
      if(!client || !UID) throw Error('Configure database URL, public key and authorised account UID before signing in.');
      async function verify(){
        const ticket=++serial.current;
        try{
          const {data,error}=await client.auth.getUser();
          if(!live || ticket!==serial.current)return;
          if(error || data.user?.id!==UID){setUser(null);return;}
          setUser({id:data.user.id,username:data.user.email,role:TEST?'Test Admin':'Admin'});
        }catch(e){if(live && ticket===serial.current){setUser(null);setError('Could not verify login. Check your connection.');}}
        finally{if(live && ticket===serial.current)setChecking(false);}
      }
      subscription=client.auth.onAuthStateChange((event,session)=>{
        if(!live)return;
        if(!session){++serial.current;setUser(null);setChecking(false);}
        else if(event!=='INITIAL_SESSION')setTimeout(()=>{if(live)verify();},0);
      }).data.subscription;
      await verify();
    }).catch(e=>{if(live){setError(e.message);setChecking(false);}});
    return()=>{live=false;++serial.current;subscription?.unsubscribe();};
  },[]);
  async function login(e){
    e.preventDefault();if(busy)return;setBusy(true);setError('');
    try{
      const client=await getClient();if(!client)throw Error('Missing database configuration.');
      const {data,error}=await client.auth.signInWithPassword({email:email.trim(),password});
      if(error)throw error;
      if(data.user?.id!==UID){await client.auth.signOut({scope:'local'});throw Error('This account is not authorised for this project.');}
      setPassword('');
    }catch(e){setError(e.message || 'Sign in failed.');}finally{setBusy(false);}
  }
  async function logout(){
    const client=await getClient();const {error}=await client.auth.signOut({scope:'local'});
    if(error){window.alert('Sign out failed. Please try again.');return;}
    ++serial.current;setUser(null);
  }
  if(checking)return <div className="login-wrapper">Checking login…</div>;
  if(user)return <><div className="env-banner">{TEST?'TEST DATABASE · ':''}v{version} · {TEST?'Not production':'Business workspace'}</div><App key={user.id} user={user} onLogout={logout}/></>;
  return <div className="login-wrapper"><form className="login-card" onSubmit={login}>
    <img className="login-brand-logo" src="/company-logo.jpeg" alt="Lavanya’s Mart — Aari Materials"/><h1>Lavanya OMS</h1><p>v{version} · {TEST?'Test workspace':'Business workspace'}</p>
    {error && <p role="alert" className="login-error">{error}</p>}
    <div className="login-field"><label htmlFor="email">Email</label><input id="email" type="email" autoComplete="username" required value={email} onChange={e=>setEmail(e.target.value)}/></div>
    <div className="login-field"><label htmlFor="password">Password</label><input id="password" type="password" autoComplete="current-password" required value={password} onChange={e=>setPassword(e.target.value)}/></div>
    <button className="login-btn" disabled={busy}>{busy?'Signing in…':'Sign in'}</button>
  </form></div>;
}
