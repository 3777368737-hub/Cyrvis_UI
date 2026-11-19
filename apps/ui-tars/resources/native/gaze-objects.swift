// Read-only local object discovery. Never invokes accessibility actions.
import AppKit
import ApplicationServices
import Vision
import ImageIO

func attr(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success ? value : nil
}
func frame(_ element: AXUIElement) -> CGRect? {
    guard let p = attr(element, kAXPositionAttribute), let s = attr(element, kAXSizeAttribute), CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero, size = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size), size.width >= 12, size.height >= 12 else { return nil }
    return CGRect(origin: point, size: size)
}
func box(_ r: CGRect) -> [String:Double] { return ["x":r.minX,"y":r.minY,"width":r.width,"height":r.height] }
func rect(_ value: [String:Any]) -> CGRect { CGRect(x:value["x"] as? Double ?? 0,y:value["y"] as? Double ?? 0,width:value["width"] as? Double ?? 0,height:value["height"] as? Double ?? 0) }
func distance(_ p: CGPoint, _ b: CGRect) -> Double { hypot(max(b.minX-p.x,0,p.x-b.maxX),max(b.minY-p.y,0,p.y-b.maxY)) }
func fingerprint(_ image:CGImage?,_ bounds:CGRect)->String {
    guard let image=image,let crop=image.cropping(to:bounds.insetBy(dx:bounds.width*0.12,dy:bounds.height*0.12)) else{return ""}
    var bytes=[UInt8](repeating:0,count:4*4*4)
    let ok=bytes.withUnsafeMutableBytes { buffer -> Bool in
        guard let context=CGContext(data:buffer.baseAddress,width:4,height:4,bitsPerComponent:8,bytesPerRow:16,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else{return false}
        context.draw(crop,in:CGRect(x:0,y:0,width:4,height:4));return true
    }
    guard ok else{return ""}
    var hash:UInt64=1469598103934665603
    for (i,value) in bytes.enumerated() where i%4 != 3 {hash=(hash ^ UInt64(value/64)) &* 1099511628211}
    return String(hash,radix:16)
}
func object(_ id:String,_ scene:String,_ label:String,_ role:String,_ source:String,_ bounds:CGRect) -> [String:Any] {
    ["id":id,"scene":scene,"label":String(label.prefix(100)),"role":role,"source":source,"bounds":box(bounds)]
}
func scan(_ request: [String:Any]) -> [String:Any] {
    let area=rect(request["bounds"] as? [String:Any] ?? [:])
    let point=CGPoint(x:request["x"] as? Double ?? 0,y:request["y"] as? Double ?? 0)
    if let encoded=request["image"] as? String, let data=Data(base64Encoded:encoded) {
        let scene=request["scene"] as? String ?? "visual"
        let clip=rect(request["clip"] as? [String:Any] ?? box(area))
        let rectangles=VNDetectRectanglesRequest()
        rectangles.maximumObservations=35; rectangles.minimumConfidence=0.65
        rectangles.minimumSize=0.035; rectangles.minimumAspectRatio=0.35; rectangles.maximumAspectRatio=1.0
        rectangles.quadratureTolerance=18
        let text=VNRecognizeTextRequest();text.recognitionLevel = .fast;text.usesLanguageCorrection=false
        text.recognitionLanguages=["zh-Hans","en-US"]
        do {
            let cgSource=CGImageSourceCreateWithData(data as CFData,nil)
            let cg=cgSource.flatMap{CGImageSourceCreateImageAtIndex($0,0,nil)}
            try VNImageRequestHandler(data:data,options:[:]).perform([rectangles,text])
            func map(_ b:CGRect)->CGRect { CGRect(x:area.minX+b.minX*area.width,y:area.minY+(1-b.maxY)*area.height,width:b.width*area.width,height:b.height*area.height) }
            let words=(text.results ?? []).compactMap { item -> (CGRect,String)? in
                guard let value=item.topCandidates(1).first?.string, !value.isEmpty else{return nil}
                return (map(item.boundingBox),value)
            }
            var result:[[String:Any]]=[]
            for item in rectangles.results ?? [] {
                let b=map(item.boundingBox)
                guard b.width>=36,b.height>=36,b.width*b.height<area.width*area.height*0.35,clip.contains(CGPoint(x:b.midX,y:b.midY)),distance(point,b)<220 else{continue}
                let nearby=words.filter { $0.0.minY>=b.maxY-8 && $0.0.minY<b.maxY+65 && abs($0.0.midX-b.midX)<b.width*0.6 }.prefix(2).map{$0.1}.joined(separator:" · ")
                let label=nearby.isEmpty ? "图像区域（名称待确认）" : nearby
                let pixel=CGRect(x:item.boundingBox.minX*Double(cg?.width ?? 1),y:(1-item.boundingBox.maxY)*Double(cg?.height ?? 1),width:item.boundingBox.width*Double(cg?.width ?? 1),height:item.boundingBox.height*Double(cg?.height ?? 1))
                let id="\(scene):image:\(Int(b.minX/8)):\(Int(b.minY/8)):\(Int(b.width/8)):\(fingerprint(cg,pixel)):\(label)"
                result.append(object(id,scene,label,"image-region","vision",b))
            }
            for (b,label) in words where b.width>=18 && b.height>=12 && clip.contains(CGPoint(x:b.midX,y:b.midY)) && distance(point,b)<200 {
                if result.contains(where:{ item in let r=rect(item["bounds"] as! [String:Any]);return r.insetBy(dx:-12,dy:-65).contains(CGPoint(x:b.midX,y:b.midY)) }) {continue}
                result.append(object("\(scene):text:\(Int(b.minX/8)):\(Int(b.minY/8)):\(label)",scene,label,"text","text",b))
            }
            return ["scene":scene,"objects":result]
        } catch { return ["scene":scene,"objects":[],"error":"本地图像区域识别失败"] }
    }
    let windows=CGWindowListCopyWindowInfo([.optionOnScreenOnly],kCGNullWindowID) as? [[String:Any]] ?? []
    let selected=windows.first { info in
        guard (info[kCGWindowLayer as String] as? Int)==0, (info[kCGWindowAlpha as String] as? Double ?? 1)>0, let dict=info[kCGWindowBounds as String] as? [String:Any], let b=CGRect(dictionaryRepresentation:dict as CFDictionary) else{return false}
        return b.contains(point) && b.width>30 && b.height>30
    }
    let finder=NSRunningApplication.runningApplications(withBundleIdentifier:"com.apple.finder").first?.processIdentifier ?? 0
    let pid=selected?[kCGWindowOwnerPID as String] as? Int32 ?? finder
    let windowId=selected?[kCGWindowNumber as String] as? Int ?? 0
    let scene="\(pid):\(windowId)"
    let windowBox=(selected?[kCGWindowBounds as String] as? [String:Any]).flatMap { CGRect(dictionaryRepresentation:$0 as CFDictionary) } ?? area
    guard AXIsProcessTrusted() else {return ["scene":scene,"objects":[],"clip":box(windowBox),"windowId":windowId,"permission":false]}
    let application=AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(),0.08)
    let roots=attr(application,kAXWindowsAttribute) as? [AXUIElement] ?? [application]
    let root=roots.min { a,b in
        let aa=frame(a) ?? .zero, bb=frame(b) ?? .zero
        return hypot(aa.minX-windowBox.minX,aa.minY-windowBox.minY)<hypot(bb.minX-windowBox.minX,bb.minY-windowBox.minY)
    } ?? application
    let started=ProcessInfo.processInfo.systemUptime
    var queue:[(AXUIElement,Int)]=[(root,0)], index=0, objects:[[String:Any]]=[]
    let roles:Set<String>=["AXButton","AXImage","AXLink","AXTextField","AXPopUpButton","AXCheckBox","AXRadioButton","AXRow","AXCell","AXStaticText","AXMenuItem"]
    while index<queue.count && index<1100 && ProcessInfo.processInfo.systemUptime-started<0.35 {
        let (element,depth)=queue[index];index+=1
        let role=attr(element,kAXRoleAttribute) as? String ?? ""
        if role=="AXSecureTextField" {continue}
        let b=frame(element)
        if let b=b, !b.intersects(windowBox.intersection(area)) {continue}
        if roles.contains(role), let b=b, b.width*b.height<area.width*area.height*0.32, distance(point,b)<220 {
            let title=attr(element,kAXTitleAttribute) as? String ?? ""
            let detail=attr(element,kAXDescriptionAttribute) as? String ?? ""
            let value=role=="AXStaticText" ? attr(element,kAXValueAttribute) as? String ?? "" : ""
            let label=[title,detail,value].first(where:{!$0.isEmpty}) ?? (role=="AXImage" ? "图片（名称待确认）" : role)
            let id="\(scene):\(role):\(Int(b.minX/4)):\(Int(b.minY/4)):\(label.prefix(80))"
            objects.append(object(id,scene,label,role,"accessibility",b))
        }
        if depth<18, let children=attr(element,kAXChildrenAttribute) as? [AXUIElement] {queue.append(contentsOf:children.prefix(300).map{($0,depth+1)})}
    }
    return ["scene":scene,"objects":objects,"clip":box(windowBox),"windowId":windowId,"permission":true]
}
while let line=readLine() {
    autoreleasepool {
        do {
            guard let data=line.data(using:.utf8), let request=try JSONSerialization.jsonObject(with:data) as? [String:Any] else {return}
            let result=scan(request)
            let output=try JSONSerialization.data(withJSONObject:result,options:[.sortedKeys])
            FileHandle.standardOutput.write(output);FileHandle.standardOutput.write(Data([10]))
        } catch { FileHandle.standardOutput.write(Data("{\"scene\":\"error\",\"objects\":[],\"error\":\"对象识别输入无效\"}\n".utf8)) }
    }
}
