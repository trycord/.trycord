Promise.allSettled([fetch('/health',{cache:'no-store'}),fetch('/ready',{cache:'no-store'})]).then((results)=>{
  const ok=results.every((x)=>x.status==='fulfilled' && x.value.ok);
  const text=document.getElementById('status-text');
  const detail=document.getElementById('status-detail');
  if(text) text.textContent=ok?'Operational':'One or more checks failed';
  if(detail) detail.textContent='Health: '+(results[0].status==='fulfilled'?results[0].value.status:'unreachable')+' · Ready: '+(results[1].status==='fulfilled'?results[1].value.status:'unreachable');
}).catch(()=>{const text=document.getElementById('status-text');if(text) text.textContent='Status unavailable';});
