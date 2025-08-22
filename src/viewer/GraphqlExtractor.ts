import {DocumentNode, parse} from "graphql/language";

export function extract(frame: any) {
    if (frame.data) {
        const data = JSON.parse(frame.data.toString());
        try {
            if (data.query) {
                const node = parse(data.query)
                return getExtractField(node)
            }
            if (data.data && typeof data.data === "object") {
                const keys = Object.keys(data.data);
                if (keys.length > 0) {
                    return keys[0]
                }
            }
        } catch (e) {
            console.error("extract error:", e);
        }
    }
    return
}

function getExtractField(documentNode: DocumentNode) {

    const {definitions} = documentNode
    if (definitions.length !== 1) {
        return
    }

    //@ts-ignore
    const {selections} = definitions.at(0).selectionSet
    if (selections.length !== 1) {
        return
    }

    return selections.at(0).name.value
}