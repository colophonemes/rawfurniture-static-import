// idea from https://hoverbaum.net/2018/03/22/Wordpress-to-Contentful-migration/
const Listr = require('listr')
const { getFormatter } = require('./formatters')
const Contentful = require('contentful-management')
const mime = require('mime-types')
const hash = require('hash.js')
const retry = require('async-retry')
const Bottleneck = require('bottleneck')
const { DateTime } = require('luxon')

const { CONTENTFUL_CONTENT_MANAGEMENT_TOKEN, CONTENTFUL_SPACE_ID, CONTENTFUL_ENVIRONMENT_ID } = process.env

var contentful = Contentful.createClient({
  // This is the access token for this space. Normally you get the token in the Contentful web app
  accessToken: CONTENTFUL_CONTENT_MANAGEMENT_TOKEN
})

const limiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: 100
})

const DATA_FILE = require('./data.json')
const SKIP_CONTENT_TYPES = ['acf', 'nav_menu_item', 'wpcf7_contact_form']

const splitDataByPostType = async (data) => {
  const content = {}
  for (const itemData of data.rss.channel.item) {
    const contentType = itemData['wp:post_type']._cdata
    if (SKIP_CONTENT_TYPES.includes(contentType)) continue
    content[contentType] = content[contentType] || []
    content[contentType].push(itemData)
  }
  return content
}

const formatContent = async data => {
  const content = {}
  for (const key in data) {
    const formatter = getFormatter(key)
    content[key] = await Promise.all(data[key].map(formatter))
  }
  return content
}

const uploadAttachments = async (ctx) => {
  const { environment } = ctx
  const assets = []
  for (const attachment of ctx.content.attachment) {
    const { title, post_name, attachment_url, guid, post_parent } = attachment
    const assetId = hash.sha256().update(guid).digest('hex')
    let asset
    // check if the asset already exists in the space
    try {
      asset = await limiter.schedule(() => environment.getAsset(assetId))
    } catch (err) {
      // check the status code of the error
      const errData = JSON.parse(err.message)
      if (errData.status !== 404) throw err
      // if it doesn't exist, create it
      const contentType = mime.lookup(attachment.attachment_url)
      await retry(async bail => {
        asset = await limiter.schedule(() => environment.createAssetWithId(assetId, {
          fields: {
            title: {
              'en-US': title
            },
            file: {
              'en-US': {
                contentType: contentType,
                fileName: `${post_name}.${mime.extension(contentType)}`,
                upload: attachment_url
              }
            }
          }
        }))
      })
      await retry(async bail => {
        await asset.processForAllLocales()
      })
    }
    // store the asset with any post parents, so that they can be attached later
    assets.push({ asset, attachment })
  }
  return assets
}

const formatPostMeta = postMeta => {
  const meta = {}
  for (const item of postMeta) {
    meta[item['wp:meta_key']._cdata] = item['wp:meta_value']._cdata
  }
  return meta
}

const formatEntryFields = (entryFields, locale = 'en-US') => {
  const formattedEntryFields = {}
  for (const key in entryFields) {
    formattedEntryFields[key] = { [locale]: entryFields[key] }
  }
  return formattedEntryFields
}

const createFurniture = async ctx => {
  const {environment, content: { furniture }, assets} = ctx
  return Promise.all(furniture.filter(post => post.post_name).map(async post => {
    const { title, post_name, contentRichText, guid, post_date, postmeta, categorySlug } = post
    const entryId = getEntryId(guid)
    // format post data
    const images = assets
      .filter(({attachment}) => attachment.post_parent === post.post_id)
      .map(({ asset }) => ({
        sys: {
          type: 'Link',
          linkType: 'Asset',
          id: asset.sys.id
        }
      }))
    // get data from post meta
    const { dimensions, sold, price, } = formatPostMeta(postmeta)
    let categories
    if (categorySlug) {
      const contentfulCategory = ctx.categories.filter(({ fields }) => fields.slug['en-US'] === categorySlug)[0]
      if (contentfulCategory) {
        categories = [{
          sys: {
            type: 'Link',
            linkType: 'Entry',
            id: contentfulCategory.sys.id
          }
        }]
      }
    }
    // scaffold the data
    const entryData = {
      sys: {
        createdAt: DateTime.fromISO(post_date.split(' ')[0]).toUTC().toString()
      },
      fields: formatEntryFields({
        title,
        slug: post_name,
        body: contentRichText,
        images,
        price: parseFloat(price, 10),
        dimensions,
        sold: Boolean(sold),
        categories
      })
    }
    // create the entry
    try {
      const entries = await getOrCreateEntry(environment, 'furniture', entryId, entryData)
      return entries
    } catch (err) {
      console.error(`Error creating ${title}`, entryData, err)
    }
  }))
}

const formatCategories = data => {
  const categories = []
  for (const category of data.rss.channel['wp:category']) {
    categories.push({
      title: category['wp:cat_name']._cdata,
      slug: category['wp:category_nicename']._cdata,
      category_id: category['wp:term_id']
    })
  }
  return categories
}

// get a deterministic id based on supplied (unique) input data
const getEntryId = input => hash.sha256().update(input).digest('hex').substr(0, 10)

const createCategories = async (ctx) => {
  const { environment } = ctx
  const categories = formatCategories(ctx.data)
  return Promise.all(categories.map(category => {
    const { title, slug } = category
    const entryId = getEntryId(slug)
    return getOrCreateEntry(environment, 'category', entryId, {
      fields: formatEntryFields({ title, slug })
    })
  }))
}

const createPages = async ctx => {
  const { environment, content: { page }, assets } = ctx
  return Promise.all(page.map(async post => {
    const { title, post_name, contentRichText, guid, post_date } = post
    const entryId = getEntryId(guid)
    // format post data
    const featuredImage = assets
      .filter(({ attachment }) => attachment.post_parent === post.post_id)
      .map(({ asset }) => ({
        sys: {
          type: 'Link',
          linkType: 'Asset',
          id: asset.sys.id
        }
      }))[0]
    // scaffold the data
    const entryData = {
      sys: {
        createdAt: DateTime.fromISO(post_date.split(' ')[0]).toUTC().toString()
      },
      fields: formatEntryFields({
        title,
        slug: post_name,
        body: contentRichText,
        featuredImage
      })
    }
    // create the entry
    try {
      const entries = await getOrCreateEntry(environment, 'page', entryId, entryData)
      return entries
    } catch (err) {
      console.error(`Error creating ${title}`, entryData, err)
    }
  }))
}

const getOrCreateEntry = async (environment, contentTypeId, entryId, entryData) => {
  let entry
  try {
    entry = await limiter.schedule(() => environment.getEntry(entryId))
  } catch (err) {
    // check the status code of the error
    const errData = JSON.parse(err.message)
    if (errData.status !== 404) throw err
    // create the entry
    entry = await limiter.schedule(() => environment.createEntryWithId(contentTypeId, entryId, entryData))
  }
  await limiter.schedule(() => entry.publish())
  return entry
}

const tasks = new Listr([
  {
    title: 'Split data by post type',
    task: async (ctx, task) => {
      ctx.contentRaw = await splitDataByPostType(ctx.data)
    }
  },
  {
    title: 'Format post data',
    task: async (ctx, task) => {
      ctx.content = await formatContent(ctx.contentRaw)
    }
  },
  {
    title: 'Get Contentful Space',
    task: async (ctx, task) => {
      ctx.space = await contentful.getSpace(CONTENTFUL_SPACE_ID)
      ctx.environment = await ctx.space.getEnvironment(CONTENTFUL_ENVIRONMENT_ID)
    }
  },
  {
    title: 'Upload attachments as Contentful Assets',
    task: async (ctx, task) => {
      ctx.assets = await uploadAttachments(ctx)
    }
  },
  {
    title: 'Create categories',
    task: async (ctx, task) => {
      ctx.categories = await createCategories(ctx)
    }
  },
  {
    title: 'Create Furniture posts',
    task: async (ctx, task) => {
      ctx.furniture = await createFurniture(ctx)
    }
  },
  {
    title: 'Create Pages',
    task: async (ctx, task) => {
      ctx.pages = await createPages(ctx)
    }
  }
])

;(async () => {
  try {
    const ctx = await tasks.run({ data: DATA_FILE })
    console.log(ctx.pages)
  } catch (err) {
    console.error(err)
  }
})()
