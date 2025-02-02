import { InvalidRequestError } from '@atproto/xrpc-server'
import * as common from '@atproto/common'
import { Server } from '../../../../lexicon'
import * as locals from '../../../../locals'
import { paginate, TimeCidKeyset } from '../../../../db/pagination'
import { getDeclaration } from '../util'
import ServerAuth from '../../../../auth'

export default function (server: Server) {
  server.app.bsky.notification.list({
    auth: ServerAuth.verifier,
    handler: async ({ params, auth, res }) => {
      const { db, imgUriBuilder } = locals.get(res)
      const { limit, before } = params
      const requester = auth.credentials.did
      const { ref } = db.db.dynamic

      let notifBuilder = db.db
        .selectFrom('user_notification as notif')
        .where('notif.userDid', '=', requester)
        .innerJoin('ipld_block', 'ipld_block.cid', 'notif.recordCid')
        .innerJoin('did_handle as author', 'author.did', 'notif.author')
        .leftJoin(
          'profile as author_profile',
          'author_profile.creator',
          'author.did',
        )
        .select([
          'notif.recordUri as uri',
          'notif.recordCid as cid',
          'author.did as authorDid',
          'author.declarationCid as authorDeclarationCid',
          'author.actorType as authorActorType',
          'author.handle as authorHandle',
          'author_profile.displayName as authorDisplayName',
          'author_profile.avatarCid as authorAvatarCid',
          'notif.reason as reason',
          'notif.reasonSubject as reasonSubject',
          'notif.indexedAt as indexedAt',
          'ipld_block.content as recordBytes',
        ])

      const keyset = new NotifsKeyset(
        ref('notif.indexedAt'),
        ref('notif.recordCid'),
      )
      notifBuilder = paginate(notifBuilder, {
        before,
        limit,
        keyset,
      })

      const [user, notifs] = await Promise.all([
        db.db
          .selectFrom('user')
          .innerJoin('did_handle', 'did_handle.handle', 'user.handle')
          .selectAll()
          .where('did', '=', requester)
          .executeTakeFirst(),
        notifBuilder.execute(),
      ])

      if (!user) {
        throw new InvalidRequestError(`Could not find user: ${requester}`)
      }

      const notifications = notifs.map((notif) => ({
        uri: notif.uri,
        cid: notif.cid,
        author: {
          did: notif.authorDid,
          declaration: getDeclaration('author', notif),
          handle: notif.authorHandle,
          displayName: notif.authorDisplayName || undefined,
          avatar: notif.authorAvatarCid
            ? imgUriBuilder.getCommonSignedUri('avatar', notif.authorAvatarCid)
            : undefined,
        },
        reason: notif.reason,
        reasonSubject: notif.reasonSubject || undefined,
        record: common.ipldBytesToRecord(notif.recordBytes),
        isRead: notif.indexedAt <= user.lastSeenNotifs,
        indexedAt: notif.indexedAt,
      }))

      return {
        encoding: 'application/json',
        body: {
          notifications,
          cursor: keyset.packFromResult(notifs),
        },
      }
    },
  })
}

type NotifRow = { indexedAt: string; cid: string }
class NotifsKeyset extends TimeCidKeyset<NotifRow> {
  labelResult(result: NotifRow) {
    return { primary: result.indexedAt, secondary: result.cid }
  }
}
