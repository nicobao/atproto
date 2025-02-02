import { Server } from '../../../lexicon'
import { InvalidRequestError } from '@atproto/xrpc-server'
import * as locals from '../../../locals'

export default function (server: Server) {
  server.com.atproto.handle.resolve(async ({ params, res }) => {
    const { db, services, config } = locals.get(res)

    const handle = params.handle

    let did = ''
    if (!handle || handle === config.hostname) {
      // self
      did = config.serverDid
    } else {
      const supportedHandle = config.availableUserDomains.some((host) =>
        handle.endsWith(host),
      )
      if (!supportedHandle) {
        throw new InvalidRequestError('Not a supported handle domain')
      }
      const user = await services.actor(db).getUser(handle)
      if (!user) {
        throw new InvalidRequestError('Unable to resolve handle')
      }
      did = user.did
    }

    return {
      encoding: 'application/json',
      body: { did },
    }
  })
}
