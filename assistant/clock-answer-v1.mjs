// Revision 3. Also recognize natural requests to tell the user what time it is.
export function clockAnswer(text,{michaelMode=false,now=new Date(),timeZone=process.env.KITT_TIMEZONE||Intl.DateTimeFormat().resolvedOptions().timeZone}={}){
  const question=String(text).toLowerCase().trim().replaceAll('’',"'").replace(/[?.!,]+$/g,'').trim()
    .replace(/^please\s+/,'').replace(/,?\s+please$/,'')
    .replace(/^(?:can|could|would) you (?:please )?tell me\s+/,'tell me ');
  const time=/^(?:what time(?: is it(?: now| right now)?)?|what(?:'s| is) the (?:current )?time|tell me (?:the )?(?:current )?time|tell me what time it is(?: now| right now)?)$/;
  const date=/^(?:(?:what|which) day(?: of (?:the )?week)? (?:is it|is (?:it )?today)|what date is (?:it|today)|what(?:'s| is) (?:today's date|the (?:current )?date)|what(?:'s| is) the date today|tell me (?:the )?(?:current date|date|day of the week)|tell me what day(?: of (?:the )?week)? (?:it is|today is))$/;
  const isTime=time.test(question);if(!isTime&&!date.test(question))return null;
  const options={timeZone,...(isTime?{hour:'numeric',minute:'2-digit',hour12:true}:{weekday:'long',month:'long',day:'numeric',year:'numeric'})};
  const value=new Intl.DateTimeFormat('en-US',options).format(now);
  return `It's ${value}, ${michaelMode?'Michael':'Driver'}.`;
}
