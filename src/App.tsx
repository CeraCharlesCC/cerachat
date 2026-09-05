import { useEffect, useState } from 'react'
import './App.css'
import { bootstrap, getMessages } from './lib/backend'
import type { BootstrapState, Message } from './types'
export default function App(){
 const [state,setState]=useState<BootstrapState|null>(null); const [messages,setMessages]=useState<Message[]>([])
 useEffect(()=>{void bootstrap().then(s=>{setState(s);if(s.conversations[0])void getMessages(s.conversations[0].id).then(setMessages)})},[])
 return <div className="shell"><aside><h2>Threads</h2>{state?.conversations.map(c=><div key={c.id}>{c.title}</div>)}</aside><main><h1>CeraChat</h1>{messages.map(m=><article key={m.id}><b>{m.role}</b><p>{m.content}</p></article>)}</main><aside><h2>Context Workspace</h2>{state?.slices.map(s=><p key={s.id}>{s.source_name}</p>)}</aside></div>
}
