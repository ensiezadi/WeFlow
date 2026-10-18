import { importDiaryFiles } from '../utils/chatDiary'

self.onmessage = (event: MessageEvent<Array<{ name: string; content: string }>>) => {
  try { self.postMessage({ archive: importDiaryFiles(event.data) }) }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }) }
}
