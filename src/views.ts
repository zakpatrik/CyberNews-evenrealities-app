import {
  ListContainerProperty,
  ListItemContainerProperty,
  TextContainerProperty,
} from '@evenrealities/even_hub_sdk'
import {
  SCREEN_W,
  SCREEN_H,
  HEADER_H,
  ID_HEADER,
  ID_LIST,
  ID_DETAIL,
} from './config'

export interface PageContainers {
  containerTotalNum: number
  textObject: TextContainerProperty[]
  listObject?: ListContainerProperty[]
}

/**
 * List view: a non-interactive status line above a full-width selectable list.
 * The OS list widget owns scrolling and selection; we only supply the labels
 * and react to the click it reports back.
 */
export function listPage(headerText: string, rows: string[]): PageContainers {
  const header = new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: SCREEN_W,
    height: HEADER_H,
    borderWidth: 0,
    borderColor: 0,
    paddingLength: 4,
    containerID: ID_HEADER,
    containerName: 'header',
    content: headerText,
    isEventCapture: 0,
  })

  const list = new ListContainerProperty({
    xPosition: 0,
    yPosition: HEADER_H,
    width: SCREEN_W,
    height: SCREEN_H - HEADER_H,
    borderWidth: 0,
    borderColor: 0,
    borderRadius: 0,
    paddingLength: 4,
    containerID: ID_LIST,
    containerName: 'stories',
    isEventCapture: 1,
    itemContainer: new ListItemContainerProperty({
      itemCount: rows.length,
      itemWidth: SCREEN_W,
      isItemSelectBorderEn: 1,
      itemName: rows,
    }),
  })

  return { containerTotalNum: 2, textObject: [header], listObject: [list] }
}

/**
 * Detail view: one full-canvas text container. Paging happens in place via
 * textContainerUpgrade, so this layout is built once per story opened.
 */
export function detailPage(content: string): PageContainers {
  const body = new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: SCREEN_W,
    height: SCREEN_H,
    borderWidth: 0,
    borderColor: 0,
    paddingLength: 4,
    containerID: ID_DETAIL,
    containerName: 'detail',
    content,
    isEventCapture: 1,
  })

  return { containerTotalNum: 1, textObject: [body] }
}
