export function spokenAnswer(value, {citations = []} = {}) {
  const links = [];
  let text = String(value || '');
  // Remove only explicit annotation spans; ordinary numbers and parentheticals remain.
  const spans = citations.filter(item => Number.isInteger(item.start_index) && Number.isInteger(item.end_index) && item.start_index >= 0 && item.end_index > item.start_index && item.end_index <= text.length).sort((a, b) => b.start_index - a.start_index);
  for (const item of spans) text = text.slice(0, item.start_index) + text.slice(item.end_index);
  text = text.replace(/\uE200[^\uE201]*\uE201/g, '').replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g, (_, label, url) => { links.push({label, url}); return label; });
  text = text.replace(/https?:\/\/\S+/g, '').replace(/[*_#`]/g, '').replace(/^\s*[-•]\s+/gm, '').trim();
  return {text, links};
}
