"use client";
import { useRef,useState,type FormEvent,type ReactNode } from "react";
import {useRouter}from"next/navigation";
export function OperationForm({action,children,label="Simpan",onSaved,className="",actions,blocked=false,data:extra={}}:{action:string;children?:ReactNode;actions?:ReactNode;blocked?:boolean;label?:string;onSaved?:(value:unknown)=>void;className?:string;data?:Record<string,unknown>}){
 const router=useRouter();const key=useRef<string|null>(null);const[busy,setBusy]=useState(false),[error,setError]=useState(""),[saved,setSaved]=useState(false);
 async function submit(e:FormEvent<HTMLFormElement>){e.preventDefault();setBusy(true);setError("");setSaved(false);key.current??=crypto.randomUUID();const values={...Object.fromEntries(new FormData(e.currentTarget)),...extra,client_id:key.current};try{
 const r=await fetch("/api/staffing/operations",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action,data:values})});const value=await r.json();if(!r.ok)throw new Error(value.error||"Data gagal disimpan.");key.current=null;onSaved?.(value);setSaved(true);router.refresh();
 }catch(err){setError(err instanceof Error?err.message:"Data gagal disimpan.");}finally{setBusy(false);}}
 return <form className={`ops-form ${className}`}onSubmit={submit}><fieldset disabled={busy||blocked}>{children}<div className="ops-form-actions"><button className="ops-button"type="submit">{busy?"Menyimpan…":label}</button>{actions}</div></fieldset>{error&&<p className="ops-error"role="alert">{error}</p>}{saved&&<p className="ops-success"role="status">Tersimpan.</p>}</form>;
}
