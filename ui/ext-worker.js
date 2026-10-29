// Runs one extension's code, isolated from the page. Same contract as Hayase extensions:
// the module's default export has test(), single(), batch(), movie().
import { clean } from './ext-clean.js'
let mod

self.onmessage = async ({ data: { id, fn, args } }) => {
  try {
    let res
    if (fn === 'load') {
      const url = URL.createObjectURL(new Blob([args[0]], { type: 'text/javascript' }))
      mod = (await import(url)).default
      URL.revokeObjectURL(url)
    } else if (fn === 'test') {
      res = await mod.test()
    } else {
      const [query, options] = args
      res = clean(await mod[fn]({ ...query, fetch: self.fetch.bind(self) }, options))
    }
    self.postMessage({ id, res })
  } catch (e) {
    self.postMessage({ id, err: e?.message ?? String(e) })
  }
}
