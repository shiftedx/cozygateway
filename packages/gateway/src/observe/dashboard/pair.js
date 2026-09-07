(() => {
  'use strict';
  const key='cozygateway.observe.token',form=document.getElementById('pair-form'),status=document.getElementById('pair-status');
  async function open(token){
    const response=await fetch('/observe/session',{headers:{Authorization:`Bearer ${token}`},cache:'no-store'});
    if(!response.ok)throw new Error('session');
    localStorage.setItem(key,token);
    location.replace('/observe');
  }
  form.addEventListener('submit',async event=>{
    event.preventDefault();const button=form.querySelector('button');button.disabled=true;status.textContent='Pairing this browser…';
    try{
      const response=await fetch('/pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({setupCode:form.elements.setupCode.value.trim(),deviceName:form.elements.deviceName.value.trim(),kind:'observer'})});
      if(!response.ok){status.textContent='The code could not be used. Create a new observer code in CozyChat and try again.';return;}
      const data=await response.json();if(typeof data.deviceToken!=='string')throw new Error('pair');
      await open(data.deviceToken);
    }catch{status.textContent='Pairing could not finish. Check the connection and allow this site to store its paired credential.';}finally{button.disabled=false;}
  });
  let token;try{token=localStorage.getItem(key);}catch{}
  if(token)open(token).catch(()=>{try{localStorage.removeItem(key);}catch{}});
})();
