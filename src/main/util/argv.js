// "npx -y some-server --flag 'two words'" → ['npx', '-y', 'some-server', '--flag', 'two words']
function splitCommand(line) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (let m; (m = re.exec(line));) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] !== undefined ? m[2] : m[3]);
  return out;
}
module.exports = { splitCommand };
