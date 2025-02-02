import { Kysely } from 'kysely'
import { InvalidRequestError } from '@atproto/xrpc-server'
import * as common from '@atproto/common'
import { Server } from '../../../../lexicon'
import * as GetPostThread from '../../../../lexicon/types/app/bsky/feed/getPostThread'
import * as locals from '../../../../locals'
import { DatabaseSchema } from '../../../../db/database-schema'
import { countAll } from '../../../../db/util'
import { getDeclaration } from '../util'
import ServerAuth from '../../../../auth'
import { ImageUriBuilder } from '../../../../image/uri'
import { embedsForPosts, FeedEmbeds } from '../util/embeds'

export default function (server: Server) {
  server.app.bsky.feed.getPostThread({
    auth: ServerAuth.verifier,
    handler: async ({ params, auth, res }) => {
      const { uri, depth = 6 } = params
      const { db, imgUriBuilder } = locals.get(res)
      const requester = auth.credentials.did

      const queryRes = await postInfoBuilder(db.db, requester)
        .where('post.uri', '=', uri)
        .executeTakeFirst()

      if (!queryRes) {
        throw new InvalidRequestError(`Post not found: ${uri}`, 'NotFound')
      }

      const embeds = await embedsForPosts(db.db, imgUriBuilder, [queryRes.uri])
      const thread = rowToPost(imgUriBuilder, embeds, queryRes)
      if (depth > 0) {
        thread.replies = await getReplies(
          db.db,
          imgUriBuilder,
          thread,
          depth - 1,
          requester,
        )
      }
      if (queryRes.parent !== null) {
        thread.parent = await getAncestors(
          db.db,
          imgUriBuilder,
          queryRes.parent,
          requester,
        )
      }

      return {
        encoding: 'application/json',
        body: { thread },
      }
    },
  })
}

const getAncestors = async (
  db: Kysely<DatabaseSchema>,
  imgUriBuilder: ImageUriBuilder,
  parentUri: string,
  requester: string,
): Promise<GetPostThread.Post | GetPostThread.NotFoundPost> => {
  const parentRes = await postInfoBuilder(db, requester)
    .where('post.uri', '=', parentUri)
    .executeTakeFirst()
  if (!parentRes) {
    return {
      $type: 'app.bsky.feed.getPostThread#notFoundPost',
      uri: parentUri,
      notFound: true,
    }
  }
  const embeds = await embedsForPosts(db, imgUriBuilder, [parentRes.uri])
  const parentObj = rowToPost(imgUriBuilder, embeds, parentRes)
  if (parentRes.parent !== null) {
    parentObj.parent = await getAncestors(
      db,
      imgUriBuilder,
      parentRes.parent,
      requester,
    )
  }
  return parentObj
}

const getReplies = async (
  db: Kysely<DatabaseSchema>,
  imgUriBuilder: ImageUriBuilder,
  parent: GetPostThread.Post,
  depth: number,
  requester: string,
): Promise<GetPostThread.Post[]> => {
  const res = await postInfoBuilder(db, requester)
    .where('post.replyParent', '=', parent.uri)
    .orderBy('post.createdAt', 'desc')
    .execute()
  const postUris = res.map((row) => row.uri)
  const embeds = await embedsForPosts(db, imgUriBuilder, postUris)
  const got = await Promise.all(
    res.map(async (row) => {
      const post = rowToPost(imgUriBuilder, embeds, row, parent)
      if (depth > 0) {
        post.replies = await getReplies(
          db,
          imgUriBuilder,
          post,
          depth - 1,
          requester,
        )
      }
      return post
    }),
  )
  return got
}

// selects all the needed info about a post, just need to supply the `where` clause
// @TODO break this query up, share parts with home/author feeds
const postInfoBuilder = (db: Kysely<DatabaseSchema>, requester: string) => {
  const { ref } = db.dynamic
  return db
    .selectFrom('post')
    .innerJoin('ipld_block', 'ipld_block.cid', 'post.cid')
    .innerJoin('did_handle as author', 'author.did', 'post.creator')
    .leftJoin(
      'profile as author_profile',
      'author.did',
      'author_profile.creator',
    )
    .select([
      'post.uri as uri',
      'post.cid as cid',
      'post.replyParent as parent',
      'author.did as authorDid',
      'author.declarationCid as authorDeclarationCid',
      'author.actorType as authorActorType',
      'author.handle as authorHandle',
      'author_profile.displayName as authorDisplayName',
      'author_profile.avatarCid as authorAvatarCid',
      'ipld_block.content as recordBytes',
      'ipld_block.indexedAt as indexedAt',
      db
        .selectFrom('vote')
        .whereRef('subject', '=', ref('post.uri'))
        .where('direction', '=', 'up')
        .select(countAll.as('count'))
        .as('upvoteCount'),
      db
        .selectFrom('vote')
        .whereRef('subject', '=', ref('post.uri'))
        .where('direction', '=', 'down')
        .select(countAll.as('count'))
        .as('downvoteCount'),
      db
        .selectFrom('repost')
        .select(countAll.as('count'))
        .whereRef('subject', '=', ref('post.uri'))
        .as('repostCount'),
      db
        .selectFrom('post as reply')
        .select(countAll.as('count'))
        .whereRef('replyParent', '=', ref('post.uri'))
        .as('replyCount'),
      db
        .selectFrom('repost')
        .select('uri')
        .where('creator', '=', requester)
        .whereRef('subject', '=', ref('post.uri'))
        .as('requesterRepost'),
      db
        .selectFrom('vote')
        .where('creator', '=', requester)
        .whereRef('subject', '=', ref('post.uri'))
        .where('direction', '=', 'up')
        .select('uri')
        .as('requesterUpvote'),
      db
        .selectFrom('vote')
        .where('creator', '=', requester)
        .whereRef('subject', '=', ref('post.uri'))
        .where('direction', '=', 'down')
        .select('uri')
        .as('requesterDownvote'),
    ])
}

// converts the raw SQL output to a Post object
// unfortunately not type-checked yet, so change with caution!
const rowToPost = (
  imgUriBuilder: ImageUriBuilder,
  embeds: FeedEmbeds,
  row: any,
  parent?: GetPostThread.Post,
): GetPostThread.Post => {
  return {
    $type: 'app.bsky.feed.getPostThread#post',
    uri: row.uri,
    cid: row.cid,
    author: {
      did: row.authorDid,
      declaration: getDeclaration('author', row),
      handle: row.authorHandle,
      displayName: row.authorDisplayName || undefined,
      avatar: row.authorAvatarCid
        ? imgUriBuilder.getCommonSignedUri('avatar', row.authorAvatarCid)
        : undefined,
    },
    record: common.ipldBytesToRecord(row.recordBytes),
    embed: embeds[row.uri],
    parent: parent ? { ...parent } : undefined,
    replyCount: row.replyCount || 0,
    upvoteCount: row.upvoteCount || 0,
    downvoteCount: row.downvoteCount || 0,
    repostCount: row.repostCount || 0,
    indexedAt: row.indexedAt,
    myState: {
      repost: row.requesterRepost || undefined,
      upvote: row.requesterUpvote || undefined,
      downvote: row.requesterDownvote || undefined,
    },
  }
}
