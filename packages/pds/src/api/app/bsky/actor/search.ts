import { sql } from 'kysely'
import ServerAuth from '../../../../auth'
import Database from '../../../../db'
import { Server } from '../../../../lexicon'
import * as Method from '../../../../lexicon/types/app/bsky/actor/search'
import * as locals from '../../../../locals'
import { getDeclarationSimple } from '../util'
import {
  cleanTerm,
  getUserSearchQueryPg,
  getUserSearchQuerySqlite,
  SearchKeyset,
} from '../util/search'

export default function (server: Server) {
  server.app.bsky.actor.search({
    auth: ServerAuth.verifier,
    handler: async ({ params, res }) => {
      let { term, limit } = params
      const { before } = params
      const { db, imgUriBuilder } = locals.get(res)

      term = cleanTerm(term || '')
      limit = Math.min(limit ?? 25, 100)

      if (!term) {
        return {
          encoding: 'application/json',
          body: {
            users: [],
          },
        }
      }

      const results =
        db.dialect === 'pg'
          ? await getResultsPg(db, { term, limit, before })
          : await getResultsSqlite(db, { term, limit, before })

      const users = results.map((result) => ({
        did: result.did,
        declaration: getDeclarationSimple(result),
        handle: result.handle,
        displayName: result.displayName ?? undefined,
        description: result.description ?? undefined,
        avatar: result.avatarCid
          ? imgUriBuilder.getCommonSignedUri('avatar', result.avatarCid)
          : undefined,
        indexedAt: result.indexedAt ?? undefined,
      }))

      const keyset = new SearchKeyset(sql``, sql``)

      return {
        encoding: 'application/json',
        body: {
          users,
          cursor: keyset.packFromResult(results),
        },
      }
    },
  })
}

const getResultsPg: GetResultsFn = async (db, { term, limit, before }) => {
  return await getUserSearchQueryPg(db, { term: term || '', limit, before })
    .leftJoin('profile', 'profile.creator', 'did_handle.did')
    .select([
      'distance',
      'did_handle.did as did',
      'did_handle.handle as handle',
      'did_handle.actorType as actorType',
      'did_handle.declarationCid as declarationCid',
      'profile.displayName as displayName',
      'profile.description as description',
      'profile.avatarCid as avatarCid',
      'profile.indexedAt as indexedAt',
    ])
    .execute()
}

const getResultsSqlite: GetResultsFn = async (db, { term, limit, before }) => {
  return await getUserSearchQuerySqlite(db, { term: term || '', limit, before })
    .leftJoin('profile', 'profile.creator', 'did_handle.did')
    .select([
      sql<number>`0`.as('distance'),
      'did_handle.did as did',
      'did_handle.handle as handle',
      'did_handle.actorType as actorType',
      'did_handle.declarationCid as declarationCid',
      'profile.displayName as displayName',
      'profile.description as description',
      'profile.avatarCid as avatarCid',
      'profile.indexedAt as indexedAt',
    ])
    .execute()
}

type GetResultsFn = (
  db: Database,
  opts: Method.QueryParams & { limit: number },
) => Promise<
  {
    did: string
    actorType: string
    declarationCid: string
    handle: string
    displayName: string | null
    description: string | null
    avatarCid: string | null
    distance: number
    indexedAt: string | null
  }[]
>
