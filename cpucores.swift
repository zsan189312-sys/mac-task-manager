// cpucores — 读取 Mach host_processor_info 输出每核 CPU tick
// 输出: <核心数>\n<core0_user> <core0_system> <core0_idle> <core0_nice>\n...
import Foundation

var cpuCount: natural_t = 0
var cpuInfo: processor_info_array_t? = nil
var cpuMsgCount: mach_msg_type_number_t = 0

let result = host_processor_info(mach_host_self(),
                                 PROCESSOR_CPU_LOAD_INFO,
                                 &cpuCount,
                                 &cpuInfo,
                                 &cpuMsgCount)

guard result == KERN_SUCCESS, let info = cpuInfo else {
    FileHandle.standardError.write("ERR host_processor_info \(result)\n".data(using: .utf8)!)
    exit(1)
}

var out = "\(cpuCount)\n"
for i in 0..<Int(cpuCount) {
    let base = i * Int(CPU_STATE_MAX)
    let user = info[base + Int(CPU_STATE_USER)]
    let system = info[base + Int(CPU_STATE_SYSTEM)]
    let idle = info[base + Int(CPU_STATE_IDLE)]
    let nice = info[base + Int(CPU_STATE_NICE)]
    out += "\(user) \(system) \(idle) \(nice)\n"
}
print(out, terminator: "")

let size = vm_size_t(cpuMsgCount) * vm_size_t(MemoryLayout<integer_t>.size)
vm_deallocate(mach_task_self_, vm_address_t(bitPattern: info), size)
