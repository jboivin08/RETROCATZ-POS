// src/components/Login.jsx
import React, { useState } from "react";
import { storeSession } from "../session";

export default function Login({ onLoggedIn }) {
  const [username,setUsername]=useState("");
  const [password,setPassword]=useState("");
  const [error,setError]=useState("");

  async function submit(e){
    e.preventDefault();
    setError("");
    const r = await fetch("/api/login", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ username, password })
    });
    let j = {};
    try { j = await r.json(); } catch {}
    if (!r.ok) { setError(j.error || "Login failed"); return; }
    storeSession(j.session_id, j.user);
    onLoggedIn(j);
  }

  return (
    <div style={{maxWidth:360, margin:"80px auto", padding:16}}>
      <h1 style={{fontWeight:700, fontSize:20, marginBottom:12}}>RetroCatz POS – Sign in</h1>
      <form onSubmit={submit} style={{display:"grid", gap:8}}>
        <input placeholder="Username" value={username} onChange={e=>setUsername(e.target.value)} autoFocus style={{padding:8, border:"1px solid #ccc", borderRadius:6}}/>
        <input type="password" placeholder="Password" value={password} onChange={e=>setPassword(e.target.value)} style={{padding:8, border:"1px solid #ccc", borderRadius:6}}/>
        {error ? <div style={{color:"#b00020", fontSize:12}}>{error}</div> : null}
        <button type="submit" style={{padding:"8px 12px", borderRadius:6, background:"#000", color:"#fff", border:"1px solid #000"}}>Sign in</button>
      </form>
    </div>
  );
}
