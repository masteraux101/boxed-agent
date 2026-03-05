# 项目定制指令 - Agent执行时需要不断反思以下指令

## 1. 项目性质
- 这是一个需要运行在浏览器的前端项目，不是一个用node.js运行的项目。在引入三方包要注意。
- 项目语言是英语，所以这个项目涉及的文案要用英语，但是和copilot交互可以用中文。

## 2. 项目核心功能
- 支持SOUL配置，不同session可以load 不同的SOUL
- 模型返回的代码可以推送到GitHub action去执行。
- 可以设置GitHub action的定时任务，并通过邮件或者webhook的方式通知用户。
- 项目部署在云端，存储通过用户指定的github仓库来存储（用户需要提供Github PAT）
  - 所以用户在任何地方访问存在github的session的时候，只要提供对应PAT和session仓库名字即可访问。

## 3. 项目重要功能
- skill功能，由于项目运行在浏览器，而互联网来源的Skill通常在用户的机器上执行，这就需要在针对互联网来源的的skill进行前置的提示，以正确的推送的Github Action执行。
- session的配置隔离，互相不能影响

## 4. 测试中功能，暂时不影响主体项目
- playground文件夹下的文件是针对多个运行在aciton上的action上面的测试代码，对于里面的改动不要受到以上3点的影响。
- 通过GitHub action执行长时间任务，如果时间过长，还可以自愈，意思是还可以建立下一个workflow自动接续执行。
  - watchdog和runner可以用session仓库进行中间交流，核心是有干活的有revie我的。
  - watchdog和runner需要知晓如何更新仓库并且处理仓库操作的报错情况
  - Runner：任务的执行者，职责包括：
    - 执行任务
    - 执行任务时输出日志，输出中间记录到仓库中，定时读取是否有来自watchDog的建议或者要求，并予以回复（有等待机制）
  - WatchDog：任务的监视者和评估者，职责包括：
    - 检视runner状态，包括不断读取runner生成的中间记录，并做出回复
    - 评估runner结果，不满意时重新执行

