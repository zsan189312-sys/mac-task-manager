// procinfo — 枚举全部进程（KERN_PROC_ALL，含 root/系统进程）并采集资源数据
// 输出（制表符分隔）：pid \t cpu_ns \t rcpu_ns \t diskR \t diskW \t wakeups \t rss \t path
// cpu_ns  = proc_pidinfo(PROC_PIDTASKINFO) 的 pti_total_user+system（macOS 27 不计 darwinbg/nice 线程）
// rcpu_ns = proc_pid_rusage 的 ri_user_time+ri_system_time（含后台 QoS，口径更全）
import Foundation

// ---------- 1) sysctl KERN_PROC_ALL 枚举所有进程（与 ps 同源，无 uid 过滤） ----------
var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_ALL]
let mibLen = UInt32(mib.count) // 必须为 3；传 2 只会查询 kern.proc 而失败
var size = 0
sysctl(&mib, mibLen, nil, &size, nil, 0)
guard size > 0 else { exit(1) }
var buf = [UInt8](repeating: 0, count: size)
var newSize = size
guard sysctl(&mib, mibLen, &buf, &newSize, nil, 0) == 0 else { exit(1) }

let count = newSize / MemoryLayout<kinfo_proc>.stride
let PROC_PIDTASKINFO: Int32 = 4

var out = ""
out.reserveCapacity(count * 150)

buf.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
    let base = raw.bindMemory(to: kinfo_proc.self)
    for i in 0..<count {
        let kp = base[i]
        let pid = Int(kp.kp_proc.p_pid)
        guard pid > 0 else { continue }

        // ---------- 2) CPU 时间（纳秒，两种口径）+ 常驻内存 ----------
        var cpuNs: UInt64 = 0
        var rssTask: UInt64 = 0
        var ti = proc_taskinfo()
        let tsz = MemoryLayout<proc_taskinfo>.size
        let tret = withUnsafeMutablePointer(to: &ti) {
            $0.withMemoryRebound(to: proc_taskinfo?.self, capacity: 1) {
                proc_pidinfo(Int32(pid), PROC_PIDTASKINFO, 0, $0, Int32(tsz))
            }
        }
        if tret == Int32(tsz) {
            cpuNs = ti.pti_total_user + ti.pti_total_system
            rssTask = ti.pti_resident_size
        }

        // ---------- 3) 磁盘 I/O / 唤醒次数 / rusage 口径 CPU（部分系统进程可能拒绝，置 0 继续列出） ----------
        var diskR: UInt64 = 0, diskW: UInt64 = 0, wkups: UInt64 = 0, rssRu: UInt64 = 0
        var rcpuNs: UInt64 = 0
        var stat = rusage_info_current()
        let r = withUnsafeMutablePointer(to: &stat) {
            $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) {
                proc_pid_rusage(Int32(pid), RUSAGE_INFO_CURRENT, $0)
            }
        }
        if r == 0 {
            diskR = stat.ri_diskio_bytesread
            diskW = stat.ri_diskio_byteswritten
            wkups = stat.ri_pkg_idle_wkups
            rssRu = stat.ri_resident_size
            rcpuNs = stat.ri_user_time + stat.ri_system_time
        }
        let rss = rssRu > 0 ? rssRu : rssTask

        // ---------- 4) 进程路径 ----------
        var pathBuf = [CChar](repeating: 0, count: 4096)
        let plen = proc_pidpath(Int32(pid), &pathBuf, UInt32(pathBuf.count))
        let path = plen > 0 ? String(cString: pathBuf) : ""

        out += "\(pid)\t\(cpuNs)\t\(rcpuNs)\t\(diskR)\t\(diskW)\t\(wkups)\t\(rss)\t\(path)\n"
    }
}
print(out, terminator: "")
