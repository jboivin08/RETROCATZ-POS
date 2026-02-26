// src/App.jsx
import React, { useEffect, useState } from "react";
import Login from "./components/Login";
import { fetchMe, getRole, logout } from "./session";

export default function App() {
  const [session,setSession]=useState(null);
  const [loading,setLoading]=useState(true);

  useEffect(()=>{ (async()=>{
    const me = await fetchMe();
    if (me) setSession(me);
    setLoading(false);
  })(); },[]);

  if (loading) return <div style={{padding:16}}>Loading…</div>;
  if (!session) return <Login onLoggedIn={setSession} />;

  const role = getRole();

  return (
    <div>
      <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", padding:"8px 12px", borderBottom:"1px solid #eee"}}>
        <div style={{fontWeight:600}}>RetroCatz POS</div>
        <div style={{display:"flex", gap:12, alignItems:"center"}}>
          <span style={{fontSize:12, opacity:.7}}>
            {(session?.user?.display_name || session?.user?.username) + " (" + role + ")"}
          </span>
          <button onClick={logout} style={{border:"1px solid #ccc", background:"#fff", padding:"4px 8px", borderRadius:6}}>Logout</button>
        </div>
      </div>

      <div style={{padding:16}}>
        Home screen
        {/* Inventory component can mount here later */}
      </div>
    </div>
  );
}
