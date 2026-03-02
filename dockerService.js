const Docker = require('dockerode')

const docker = new Docker({
  host: 'localhost',
  port: 2375
})

async function listContainers() {
  const containers = await docker.listContainers({ all: true })

await replyWhatsApp(sender, formatContainers(result))
return res.sendStatus(200)
    name: c.Names[0].replace('/', ''),
    status: c.State,
    id: c.Id.substring(0, 12)
  }))
}

module.exports = { listContainers }