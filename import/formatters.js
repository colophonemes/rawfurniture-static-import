const { richTextFromMarkdown } = require('@contentful/rich-text-from-markdown');
const TurndownService = require('turndown')

const getFormatter = postType => {
  switch (postType) {
    case 'furniture':
      return formatFurniture
    case 'page':
      return formatPage
    case 'attachment':
      return formatAttachment
    default:
      throw new Error(`Unknown formatter type ${postType}`)
  }
}

const getValue = value => {
  const formattedValue = value._cdata || value._text || value
  if (typeof formattedValue === 'string') return formattedValue.replace(/<!--more-->\s*/g, '').replace(/\r\n/g, '\n')
  if (typeof formattedValue === 'object' && !Object.keys(formattedValue).length) return null
  return formattedValue
}

const baseFormatter = contentType => async item => {
  const formattedItem = { contentType }
  // extract all data
  for (const key in item) {
    const formattedKey = key.replace(/^wp:/, '').replace(/:(\w)/, (match, g1) => g1.toUpperCase())
    formattedItem[formattedKey] = getValue(item[key])
  }
  // additional processing
  formattedItem.contentRichText = await htmlToRichText(formattedItem.contentEncoded)
  formattedItem.excerptRichText = await htmlToRichText(formattedItem.excerptEncoded)
  formattedItem.categorySlug = item.category && item.category._attributes && item.category._attributes.nicename
  return formattedItem
}

const formatFurniture = async item => {
  const baseFormat = await baseFormatter('furniture')(item)
  const formattedItem = {
    ...baseFormat
  }
  return formattedItem
}

const formatPage = async item => {
  const baseFormat = await baseFormatter('page')(item)
  const formattedItem = {
    ...baseFormat
  }
  return formattedItem
}

const formatAttachment = async item => {
  const baseFormat = await baseFormatter('attachment')(item)
  const formattedItem = {
    ...baseFormat
  }
  return formattedItem
}

const htmlToRichText = async html => {
  if (!html) return null
  const turndownService = new TurndownService()
  const markdown = turndownService.turndown(html)
  const document = await richTextFromMarkdown(markdown)
  return document
}

module.exports = { getFormatter }
